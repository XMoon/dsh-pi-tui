/**
 * Ctrl+R input-history search — the History EDITOR-SEAT surface (Phase 3B /
 * B3-A).
 *
 * Anatomy (ONE vertical presentation at EVERY width — a single `render(width)`
 * decides the layout):
 * - Header row: ` Input History ` plus the responsive scope tabs and the `F2`
 *   expand hint;
 * - Query row: the panel's OWN query `Input` (the query state is never
 *   duplicated);
 * - Results list: one bounded single-line virtual window (hard max 8 rows,
 *   viewport follows the selection) with a `Results · N matches` counter;
 * - Divider, then the Preview: the soft-wrapped ORIGINAL prompt text with an
 *   INDEPENDENT scroll position, a `Preview x-y/N` heading carrying the copy
 *   actions and ONE trailing metadata row;
 * - Footer hint: `Enter use · Esc cancel · Tab scope · …`.
 *
 * The Preview is never truncated: `… more` is gone, the whole source is
 * scrollable, and every painted cell maps back to its exact original UTF-16
 * offset through the shared neutral
 * {@link module:@xmoon76/dsh-pi-tui/tui/components/source-text-layout} (the
 * same mapping the Job Command page uses).
 *
 * State machine: closed → open(current/session, query="") → searching
 * (debounced) → ready → accepted → closed. Esc = cancel (the editor draft is
 * untouched — the panel never previews into it); Enter = accept (the selected
 * `content` goes to the CURRENT editor through the app's `setEditorText`,
 * NEVER a submit); Tab = scope cycle with the query preserved; Ctrl+C = cancel.
 *
 * Pointer contract (Transcript Fullscreen ONLY): the alt screen's single
 * native SGR parser dispatches press/drag/release into this component. A result
 * row click only SELECTS; the explicit `Use Selected [Enter]` / `Copy All [Alt+C]` items
 * and the Preview drag selection act, always resolved against the LAST PAINTED
 * frame (width/height, result identity, search generation) and the exact
 * original source offsets. In the regular main screen this component installs
 * no mouse behavior at all: {@link HistoryPanel.handleMouse} refuses every
 * event while the pointer capability is disabled.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/history-panel
 */

import { matchesKey } from '@xmoon76/pi-tui'
import { Input } from '@xmoon76/pi-tui'
import { dispatchMouseEvent } from '@xmoon76/pi-tui'
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { HistorySearchResult, HistorySearchSource, HistoryScope } from '../../client/history/search.ts'
import { HISTORY_SEARCH_RESULT_LIMIT } from '../../client/history/search.ts'
import { HISTORY_SEARCH_DEBOUNCE_MS } from '../../client/history/search.ts'
import { HISTORY_CHORDS, type HistoryChordId } from '../keybindings/hints.ts'
import { renderActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import {
  buildSourceTextVisualLayout,
  sourceTextPointOffset,
  sourceTextRowSelectionColumns,
  sourceTextSelectionRange,
  type SourceTextVisualLayout,
  type SourceTextVisualRow,
  type SourceTextPoint,
} from '../components/source-text-layout.ts'

/** The normalized target share of the terminal height (B3-A plan §2): the
 *  normal presentation asks for 63% and the F2-expanded one for 80%. */
export const HISTORY_SEAT_NORMAL_RATIO = 0.63
export const HISTORY_SEAT_EXPANDED_RATIO = 0.80

/** The hard cap on painted results-list rows (the counter row included). */
export const HISTORY_PANEL_MAX_LIST_ROWS = 8

/** The live geometry seam the host injects: the terminal size and the rows the
 *  non-History chrome currently occupies. `chromeRows` EXCLUDES the editor seat
 *  itself (measuring the seat from inside its own render would be cyclic) and
 *  the caller counts the live components, so the grant always follows the real
 *  frame. */
export interface HistorySeatGeometry {
  /** Live terminal columns. */
  readonly columns: () => number
  /** Live terminal rows. */
  readonly rows: () => number
  /** The rows the pinned non-History chrome occupies at `width`. */
  readonly chromeRows: (width: number) => number
}

/** What the layout must know about the CURRENT content (`actualContent`): a
 *  selectable result body exists to preview. It is the only content fact the
 *  row allocator needs — acceptance is decided separately by the live search
 *  state and the last PAINTED rows. */
export interface HistorySeatContent {
  /** Whether a selectable result body exists (no error, at least one row). */
  readonly previewable: boolean
}

/** The pure row plan of one History frame. */
export interface HistorySeatLayout {
  /** The width every painted row is clamped to. */
  readonly width: number
  /** The maximum number of rows the panel may paint (`0` = nothing fits). */
  readonly grant: number
  /** Whether the top boundary rule (transcript↔seat) is painted as the FIRST row. */
  readonly topRule: boolean
  /** Whether the mandatory Header row is painted. */
  readonly header: boolean
  /** Whether the mandatory query row is painted. */
  readonly query: boolean
  /** Whether the footer hint row is painted. */
  readonly footer: boolean
  /** Whether the bottom boundary rule (seat↔footer chrome) is painted as the
   *  LAST row, below the action bar (Owner decision D15, 2026-10-14). */
  readonly bottomRule: boolean
  /** Whether the one-row list/Preview divider is painted. */
  readonly divider: boolean
  /** Whether the one-row Preview heading is painted. */
  readonly previewHeading: boolean
  /** Whether the trailing one-row metadata is painted. */
  readonly metadata: boolean
  /** The painted results-list rows (the counter row included). */
  readonly resultsRows: number
  /** The painted RESULT rows (the counter row excluded) — the paging step. */
  readonly resultRows: number
  /** The painted Preview CONTENT rows (heading/metadata excluded). */
  readonly previewRows: number
  /** One page of results navigation: the number of visible result rows. */
  readonly listPage: number
  /** Whether a result may be accepted at all (before the paint-time check). */
  readonly acceptEnabled: boolean
}

/**
 * Derive the History seat row plan from the LIVE frame (B3-A plan §2's exact
 * algorithm + the B3-B Owner decision D15 boundary rules):
 *
 * 1. `target = floor(terminalRows × (expanded ? .80 : .63))`;
 * 2. `granted = min(target, max(0, terminalRows - nonHistoryChrome - 1))` — the
 *    `-1` is the B3 explicit policy of keeping at least one visible transcript
 *    row. The boundary rules are painted INSIDE `granted`; they never take a
 *    transcript/footer row;
 * 3. the boundary rules are PREFERRED decoration (Owner decision D15): they may
 *    compress the Results/Preview regions, but a rule is never drawn at the cost
 *    of the mandatory header/query/action bar, at least one result row or at
 *    least one Preview content row. When the budget cannot satisfy all of those,
 *    the bottom rule is removed first, then the top rule;
 * 4. Header → query → footer have first claim on the content budget, then the
 *    shrinkable body: one divider, the results window
 *    (`min(8, max(1, floor((body-1)×.55)))`) and the Preview remainder;
 * 5. the trailing metadata row exists only at `previewRegion >= 3`, the Preview
 *    heading only when it can keep at least one content row;
 * 6. `granted` is never exceeded.
 */
export function planHistorySeatLayout(
  terminalCols: number,
  terminalRows: number,
  chromeRows: number,
  expanded: boolean,
  content: HistorySeatContent,
): HistorySeatLayout {
  const width = Math.max(1, Math.floor(Number.isFinite(terminalCols) ? terminalCols : 1))
  const rows = Math.max(1, Math.floor(Number.isFinite(terminalRows) ? terminalRows : 1))
  const chrome = Math.max(0, Math.floor(Number.isFinite(chromeRows) ? chromeRows : 0))
  const target = Math.floor(rows * (expanded ? HISTORY_SEAT_EXPANDED_RATIO : HISTORY_SEAT_NORMAL_RATIO))
  const grant = Math.min(target, Math.max(0, rows - chrome - 1))

  // One candidate rule count: 2 = both boundaries, 1 = top only (the bottom
  // rule is removed first), 0 = none. A candidate is affordable only while the
  // content still keeps the mandatory chrome AND a usable body — at least one
  // result row and (when previewable) at least one Preview content row — so a
  // rule may compress the Results/Preview regions but can never push the
  // Preview below one content row; when even the top-only rule cannot afford
  // that, both rules are dropped.
  const affordable = (rules: number): boolean => {
    const inner = planHistoryContent(width, Math.max(0, grant - rules), content)
    if (!inner.header || !inner.query || !inner.footer) return false
    if (content.previewable) return inner.resultsRows > 0 && inner.previewRows > 0
    return inner.resultsRows > 0
  }
  let rules = 0
  for (const candidate of [2, 1, 0]) {
    if (affordable(candidate)) {
      rules = candidate
      break
    }
  }
  return {
    width,
    grant,
    topRule: rules >= 1,
    bottomRule: rules >= 2,
    ...planHistoryContent(width, Math.max(0, grant - rules), content),
  }
}

/** The CONTENT plan of one History frame at a given content-row budget (the
 *  boundary rules are layered on top by {@link planHistorySeatLayout}). */
function planHistoryContent(
  width: number,
  grant: number,
  content: HistorySeatContent,
): Omit<HistorySeatLayout, 'width' | 'grant' | 'topRule' | 'bottomRule'> {
  const header = grant >= 1
  const query = grant >= 2
  const footer = grant >= 3
  const chromePainted = (header ? 1 : 0) + (query ? 1 : 0) + (footer ? 1 : 0)
  const body = Math.max(0, grant - chromePainted)

  if (!content.previewable) {
    // Loading / empty / failed: ONE message row and nothing else — no divider,
    // no Preview and no acceptance of an unpainted row.
    const messageRows = Math.min(body, 1)
    return {
      header, query, footer,
      divider: false, previewHeading: false, metadata: false,
      resultsRows: messageRows, resultRows: 0, previewRows: 0, listPage: 1,
      acceptEnabled: false,
    }
  }

  if (body <= 2) {
    // Cramped: the visible selected result row(s) win over any Preview.
    return {
      header, query, footer,
      divider: false, previewHeading: false, metadata: false,
      resultsRows: body, resultRows: body, previewRows: 0, listPage: Math.max(1, body),
      acceptEnabled: body > 0,
    }
  }

  let listRegion = Math.min(HISTORY_PANEL_MAX_LIST_ROWS, Math.max(1, Math.floor((body - 1) * 0.55)))
  let previewRegion = body - 1 - listRegion
  if (previewRegion <= 0) {
    // The specified transfer: the Preview is never squeezed to zero while the
    // list still holds more than one row.
    listRegion = Math.max(1, listRegion - 1)
    previewRegion = body - 1 - listRegion
  }
  // The counter row rides the list region and only exists when it can keep at
  // least one real result row with it.
  const counterRows = listRegion >= 2 ? 1 : 0
  const resultRows = listRegion - counterRows
  const metadata = previewRegion >= 3
  const previewHeading = previewRegion - (metadata ? 1 : 0) >= 2
  const previewRows = previewRegion - (metadata ? 1 : 0) - (previewHeading ? 1 : 0)
  return {
    header, query, footer,
    divider: true, previewHeading, metadata,
    resultsRows: listRegion, resultRows, previewRows,
    listPage: Math.max(1, resultRows),
    acceptEnabled: resultRows > 0,
  }
}

/** The accepted history entry handed to the host (identity AND exact bytes). */
export interface HistoryAcceptedSelection {
  readonly id: string
  readonly content: string
}

/** Panel constructor options. */
export interface HistoryPanelOptions {
  /** The injected search source (the runner wires the file-backed one). */
  source: HistorySearchSource
  /** The working directory for the `current` scope. */
  cwd: string
  /**
   * The live session identity, captured ONCE at open time. When defined, the
   * panel defaults to the `session` scope and the Tab cycle includes it; when
   * undefined (no session yet on a deferred start) the panel defaults to
   * `current` and the session tab is hidden.
   */
  sessionId?: string
  /** Accept handler: receives the selected record's identity and content. */
  onAccept: (selection: HistoryAcceptedSelection) => void
  /** Cancel handler (Esc/Ctrl+C). The host owns the seat teardown. */
  onClose: () => void
  /**
   * Fired whenever the panel commits new results (or an error/empty state):
   * the HOST repaints the seat — an async search completing without any
   * further keypress must still paint its rows.
   */
  onResultsChanged?: () => void
  /**
   * Copy intent: the panel captured the EXACT payload synchronously (the whole
   * `content` for Copy All / the original substring for a Preview drag). The
   * host owns the clipboard capability and its settlement.
   */
  onCopy?: (text: string) => void
  /** Live seat geometry (defaults to a 24-row, chrome-free viewport). */
  geometry?: HistorySeatGeometry
  /** Optional debounce override (defaults to the search default). */
  debounceMs?: number
  /** Pre-fill the query when the panel opens. */
  initialQuery?: string
  /** Whether the pointer capability is live (Transcript Fullscreen only). */
  pointerEnabled?: () => boolean
  /**
   * Whether this panel's CAPTURED subject is still current (the host's tenant
   * `isCurrent()`: the same panel is still the live History tenant, the surface
   * generation is unchanged and the live session identity still equals the one
   * captured at open). Evaluated at every ACTING entry — a pointer event, an
   * acceptance/copy eligibility check and an async search commit — because the
   * fork dispatches pointer events without passing the Host key ladder, so
   * nothing else would notice a session change before the next revalidation
   * entry retires this tenant. Defaults to `true` (a caller with no subject).
   */
  tenantIsCurrent?: () => boolean
  /** Start in the F2-expanded presentation (default normal). */
  expanded?: boolean
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

/** One pointer action a painted cell offers. BOTH actions carry the pressed
 *  result identity: a button pressed for entry A must never act on whatever
 *  moved into the same painted cells. */
interface HistoryPointerAction {
  readonly kind: 'copyAll' | 'useSelected'
  readonly id: string
}

/** One physical row of the last painted frame (mouse hit-testing). The map is
 * built from the EXACT final rows `render()` returns, so a pointer can only act
 * on last-painted geometry. */
type HistoryMouseHit =
  | { readonly kind: 'inert' }
  | { readonly kind: 'search'; readonly xOffset: number }
  | { readonly kind: 'result'; readonly id: string }
  | { readonly kind: 'preview'; readonly row: number }
  | { readonly kind: 'actions'; readonly actions: readonly { readonly from: number; readonly to: number; readonly action: HistoryPointerAction }[] }

/** The last painted frame: the ONLY geometry a pointer event may resolve
 *  against. `generation` is the panel's search generation at paint time, so a
 *  gesture that straddles an async commit is invalidated. */
interface HistoryMouseFrame {
  readonly width: number
  readonly height: number
  readonly generation: number
  readonly hits: readonly HistoryMouseHit[]
  /** Inclusive painted row bounds of the results list, or undefined. */
  readonly listTop?: number
  readonly listBottom?: number
  /** Inclusive painted row bounds of the Preview region, or undefined. */
  readonly previewTop?: number
  readonly previewBottom?: number
  /** The panel row of the FIRST painted Preview content row, or undefined. */
  readonly previewContentTop?: number
  /** The visible result-row page (the paging step actually painted). */
  readonly listPage: number
  /** The result IDs actually painted (acceptance requires membership). */
  readonly paintedResultIds: ReadonlySet<string>
}

interface HistoryPointerGesture {
  readonly kind: 'result' | 'actions' | 'preview'
  readonly generation: number
  readonly x: number
  readonly y: number
  /** The pressed result identity (result/useSelected gestures). */
  readonly id?: string
  /** The pressed pointer action (actions gestures). */
  readonly action?: HistoryPointerAction
}

/** The shortest distinctive cwd suffix (parent + name). */
function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(part => part !== '')
  return parts.length >= 2 ? parts.slice(-2).join('/') : cwd
}

/** The list row label: the first LINE of the content, sanitized for the
 *  terminal (control bytes and escape sequences can never reach the screen). */
function resultLabel(content: string): string {
  const first = content.split('\n')[0] ?? ''
  return sanitizedPhysicalLine(first.trim())
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

/** The visual row that PAINTS the given source offset, so a re-wrap can put the
 *  reader back on the same text: the first row whose hard-break end reaches past
 *  the offset (a row boundary therefore belongs to the NEXT row — the text that
 *  starts there). */
function previewRowAtOffset(layout: SourceTextVisualLayout, offset: number): number {
  const rows = layout.rows
  if (rows.length === 0) return 0
  for (let row = 0; row < rows.length; row += 1) {
    if (offset < rows[row]!.hardBreakEnd) return row
  }
  return rows.length - 1
}

/** Truncate one plain line to the frame width (styles are applied AFTER the
 *  clamp, so a clipped line can never leak an open escape sequence). */
function clampLine(text: string, width: number): string {
  return truncateToWidth(text, width, '…')
}

/**
 * The Ctrl+R History panel. Mounted into the editor seat as the optional-seat
 * tenant component: while it is the ACTIVE, physically focused occupant it owns
 * Tab (scope), Enter (accept), Esc/Ctrl+C (cancel), the results navigation, the
 * Preview navigation, F2 and the query input. Transcript Fullscreen additionally
 * delivers press/drag/wheel into {@link HistoryPanel.handleMouse}.
 */
export class HistoryPanel implements Component, Focusable {
  private readonly state: HistoryPanelState
  private readonly input: Input
  private readonly source: HistorySearchSource
  private readonly cwd: string
  /** The live session identity captured at open time (undefined = no session
   *  yet — the session tab is hidden and the default scope is `current`). */
  private readonly sessionId: string | undefined
  private readonly onAccept: (selection: HistoryAcceptedSelection) => void
  private readonly onClose: () => void
  private readonly onResultsChanged: (() => void) | undefined
  private readonly onCopy: ((text: string) => void) | undefined
  private readonly geometry: HistorySeatGeometry
  private readonly pointerEnabled: () => boolean
  private readonly tenantIsCurrent: () => boolean
  private readonly debounceMs: number
  private expanded: boolean
  private _focused = false
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  /** The last painted frame (pointer hit-testing; `undefined` = nothing painted). */
  private frame: HistoryMouseFrame | undefined
  /** The pressed pointer gesture, valid only until its release/click. */
  private gesture: HistoryPointerGesture | undefined
  /** The Preview scroll position: the source VISUAL row painted first. It is
   *  DERIVED from {@link previewAnchorOffset} at every width, never treated as
   *  the authority across a rewrap. */
  private previewTop = 0
  /** The resize ANCHOR: the source UTF-16 offset of the first painted source
   *  row. A narrower/wider terminal re-wraps the source, and the reader must
   *  stay on the same TEXT, not on the same visual row number. */
  private previewAnchorOffset = 0
  /** The width {@link previewTop} / {@link previewAnchorOffset} were resolved
   *  at (0 = no Preview laid out yet). */
  private previewAnchorWidth = 0
  /** The result identity the current Preview anchor belongs to: a NEW selected
   *  result starts at the top, a repaint of the SAME one keeps the anchor. */
  private previewResultId: string | undefined
  /** The cached Preview layout (rebuilt only when the source or width moves). */
  private previewLayout: SourceTextVisualLayout | undefined
  /** The Preview drag anchor/focus points (source visual row + cell). */
  private previewAnchor: SourceTextPoint | undefined
  private previewFocus: SourceTextPoint | undefined

  constructor(options: HistoryPanelOptions) {
    this.source = options.source
    this.cwd = options.cwd
    this.sessionId = options.sessionId
    this.onAccept = options.onAccept
    this.onClose = options.onClose
    this.onResultsChanged = options.onResultsChanged
    this.onCopy = options.onCopy
    this.geometry = options.geometry ?? {
      columns: () => 80,
      rows: () => 24,
      chromeRows: () => 0,
    }
    this.pointerEnabled = options.pointerEnabled ?? (() => false)
    this.tenantIsCurrent = options.tenantIsCurrent ?? (() => true)
    this.expanded = options.expanded ?? false
    this.debounceMs = options.debounceMs ?? HISTORY_SEARCH_DEBOUNCE_MS
    this.input = new Input()
    // The default scope: `session` when a live session identity exists (the
    // current session's inputs are the most relevant), `current` otherwise (a
    // deferred start has no session yet; a session tab would always be empty).
    this.state = {
      scope: options.sessionId !== undefined ? 'session' : 'current',
      query: options.initialQuery ?? '',
      results: [],
      selectedIndex: 0,
      loading: false,
      generation: 0,
    }
    this.input.setValue(this.state.query)
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.input.focused = value
    // A pointer gesture only lives while this panel is the live occupant: a
    // park/close/blocker blur drops it so a restored frame can never resolve a
    // press taken against a frame the user no longer sees.
    if (!value) this.resetPointerGesture()
  }

  invalidate(): void {
    this.input.invalidate()
  }

  /** The F2 presentation state (63% vs 80% of the terminal height). */
  isExpanded(): boolean {
    return this.expanded
  }

  /** Whether the panel currently shows a settled, selectable result. */
  hasResults(): boolean {
    return !this.state.loading && this.state.error === undefined && this.state.results.length > 0
  }

  /** The selected result, or undefined when the list is empty. */
  selected(): HistorySearchResult | undefined {
    return this.state.results[this.state.selectedIndex]
  }

  /**
   * Whether one raw event is this seat's OWN cancel key — physical Escape or
   * `Ctrl+C` while the seat is the live keyboard owner. The HOST asks the live
   * tenant instead of hard-coding a physical chord in its ladder: these two keys
   * belong to the component's per-surface contract (like the Job workspace's
   * reserved Escape), not to a remappable Host action.
   */
  cancelsOnKey(data: string): boolean {
    return this.matchesChord('cancel', data)
  }

  /** Whether one raw event matches a History-local chord (one authority for the
   *  handler and its display label). */
  private matchesChord(id: HistoryChordId, data: string): boolean {
    return HISTORY_CHORDS[id].keys.some(key => matchesKey(data, key))
  }

  /**
   * The ONE acceptance predicate (B3-A plan §4): the last-PAINTED chosen result
   * must still be the currently selected ID of this live, settled panel — NOT
   * "some row exists in the last search page". Result churn, a pending query, an
   * error, an unpaintable layout, an unpainted row and a disposed panel all
   * refuse.
   */
  canAccept(): boolean {
    if (this.disposed || this.state.loading || this.state.error !== undefined) return false
    if (!this.tenantIsCurrent()) return false
    if (!this.plan(this.lastWidth()).acceptEnabled) return false
    const selected = this.selected()
    if (selected === undefined) return false
    return this.frame?.paintedResultIds.has(selected.id) === true
  }

  handleInput(data: string): void {
    // Tab: scope toggle — the query SURVIVES.
    if (this.matchesChord('scope', data)) {
      this.toggleScope()
      return
    }
    // F2: the LOCAL normal/expanded presentation preference. Closing History
    // discards it (a fresh open starts normal).
    if (this.matchesChord('expand', data)) {
      this.expanded = !this.expanded
      this.onResultsChanged?.()
      return
    }
    // Preview navigation is Alt-prefixed so the plain keys keep paging the
    // results list.
    if (this.matchesChord('preview', data)) {
      this.movePreview(data)
      return
    }
    // Copy All (both modes): the EXACT selected content, captured now.
    if (this.matchesChord('copy', data)) {
      this.copyAll()
      return
    }
    // Navigation: ↑/↓/PgUp/PgDn select within the results list.
    if (this.matchesChord('results', data)) {
      this.moveSelection(data)
      return
    }
    // Enter: accept the selected row into the editor (NO submit).
    if (this.matchesChord('accept', data)) {
      this.acceptSelected()
      return
    }
    // Esc / Ctrl+C: cancel — the editor draft is untouched.
    if (this.matchesChord('cancel', data)) {
      this.onClose()
      return
    }
    // The query input owns every other key (typing, backspace, arrows inside
    // the query, Home/End, delete...).
    this.input.handleInput(data)
    const next = this.input.getValue()
    if (next !== this.state.query) {
      this.state.query = next
      this.state.selectedIndex = 0
      this.scheduleSearch()
    }
  }

  /**
   * The ONE History pointer handler. It refuses EVERY event while the pointer
   * capability is disabled (the regular main screen has no application mouse)
   * and otherwise resolves the event against the LAST PAINTED frame: the query
   * row forwards to the Input, a result press only selects, the explicit
   * actions act on a same-action press+release, and the Preview owns the exact
   * source drag selection — whose release must land inside that same painted
   * Preview (an outside or post-resize release cancels). Wheel events scroll
   * ONLY the region under the pointer.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // The pointer path never passes the Host key ladder, so THIS is the entry
    // that must guard the live tenant identity (the captured session subject):
    // a click must never act on another session's page, and the fork keeps
    // dispatching to the component until the next revalidation retires it.
    if (this.disposed || !this.pointerEnabled() || !this.tenantIsCurrent()) return undefined
    // Only the LEFT button may start, extend or finish a History gesture: a
    // right or middle press must fall through to the terminal's own handling
    // (e.g. the Windows right-click paste path) and can never select a result,
    // start a Preview drag or activate `Use Selected [Enter]`. A drag/release that
    // carries no button code is the legacy SGR spelling of a left gesture and
    // stays valid.
    const leftButton = event.button === 'left'
      || (event.button === 'none' && (event.type === 'drag' || event.type === 'release'))
    if (event.type !== 'wheel' && !leftButton) return undefined
    // A Preview drag's RELEASE always ends the gesture, whatever geometry the
    // event carries: a release that lands outside the painted Preview (or after a
    // width/height change) safely CANCELS instead of leaving a stale anchor that
    // a later motion-only drag could extend.
    if (event.type === 'release' && this.gesture?.kind === 'preview') return this.finishPreviewDrag(event, this.gesture)

    const frame = this.frame
    // Last-painted geometry only: a resize that has not been repainted (or a
    // frame from another root) must never dispatch against stale coordinates.
    if (frame === undefined || event.width !== frame.width || event.height !== frame.height) return undefined

    if (event.type === 'wheel') return this.handleWheel(event, frame)

    const hit = frame.hits[event.y]
    if (hit === undefined) return undefined

    if (event.type === 'press') {
      if (hit.kind === 'search') {
        const result = dispatchMouseEvent(this.input, { ...event, x: event.x - hit.xOffset, y: 0 })
        // The Input's own focus intent is deliberately DROPPED: the panel is the
        // physical keyboard owner of the seat and forwards every key to the
        // Input, so promoting focus to the Input (or, one level up, to the seat
        // mount) would break the optional tenant's ownership invariant.
        return result ? { handled: true } : undefined
      }
      if (hit.kind === 'result') {
        // A result row click only SELECTS; the explicit `Use Selected [Enter]` item
        // (or Enter) accepts.
        const index = this.state.results.findIndex(candidate => candidate.id === hit.id)
        if (index === -1) return undefined
        this.gesture = { kind: 'result', generation: frame.generation, x: event.x, y: event.y, id: hit.id }
        if (this.state.selectedIndex !== index) {
          this.state.selectedIndex = index
          this.reanchorPreview()
          this.onResultsChanged?.()
        }
        return { handled: true }
      }
      if (hit.kind === 'actions') {
        const action = this.actionAt(hit, event.x)
        if (action === undefined) return undefined
        // The ACTION is only armable while the row it belongs to is a real,
        // painted, settled target.
        if (action.kind === 'copyAll' ? !this.canAcceptCopy() : !this.canAccept()) return undefined
        this.gesture = { kind: 'actions', generation: frame.generation, x: event.x, y: event.y, action }
        return { handled: true }
      }
      if (hit.kind === 'preview') {
        // A press inside the painted Preview starts the exact source drag.
        this.gesture = { kind: 'preview', generation: frame.generation, x: event.x, y: event.y }
        const point = { row: hit.row, col: Math.max(0, event.x) }
        this.previewAnchor = point
        this.previewFocus = point
        this.onResultsChanged?.()
        return { handled: true, capture: true }
      }
      return undefined
    }

    if (event.type === 'drag') {
      if (this.gesture?.kind !== 'preview' || this.gesture.generation !== frame.generation) return undefined
      if (hit.kind !== 'preview') return { handled: true, capture: true }
      this.previewFocus = { row: hit.row, col: Math.max(0, event.x) }
      this.onResultsChanged?.()
      return { handled: true, capture: true, render: true }
    }

    if (event.type === 'click') {
      const gesture = this.gesture
      const generation = frame.generation
      this.gesture = undefined
      if (gesture === undefined || gesture.generation !== generation) return undefined
      if (gesture.kind !== 'actions') return { handled: true }
      // The synthesized click already proves press and release landed on the
      // same painted cell; the gesture additionally re-proves the ACTION and
      // the pressed result identity.
      const action = hit.kind === 'actions' ? this.actionAt(hit, event.x) : undefined
      if (action === undefined || gesture.action?.kind !== action.kind) return undefined
      // The pressed ID is the identity: a page that moved under the same cells
      // must neither copy nor accept the replacement.
      if (gesture.action.id !== action.id || this.selected()?.id !== action.id) return undefined
      if (action.kind === 'copyAll') {
        if (!this.canAcceptCopy()) return undefined
        this.copyAll()
        return { handled: true, render: true }
      }
      if (!this.canAccept()) return undefined
      this.acceptSelected()
      return { handled: true }
    }

    return undefined
  }

  /**
   * End one Preview drag. The payload is captured SYNCHRONOUSLY from the range
   * the gesture selected (the async clipboard settlement downstream never
   * recomputes it) — but ONLY when the release really landed inside the painted
   * Preview of the SAME last-painted frame — the same width, the same height AND
   * the same search generation: a query that committed (or a repaint) while the
   * drag was live re-anchors the page, so its release is stale. The RELEASE
   * position is the gesture's FINAL endpoint (a terminal may deliver the last
   * motion and the release as one event), exactly like the Job Command page.
   * Any other release — outside the painted rows, on another painted region,
   * against a frame whose size moved, or across an async repaint — safely
   * CANCELS the gesture: nothing is copied and no selection survives (plan §5.2
   * step 5 / §6 H3A-09).
   */
  private finishPreviewDrag(event: TuiMouseEvent, gesture: HistoryPointerGesture): TuiMouseEventResult {
    this.gesture = undefined
    const frame = this.frame
    const hit = frame?.hits[event.y]
    const inside = frame !== undefined
      && gesture.generation === frame.generation
      && event.width === frame.width
      && event.height === frame.height
      && hit !== undefined
      && hit.kind === 'preview'
    if (!inside) {
      this.resetPreviewSelection()
      this.onResultsChanged?.()
      return { handled: true, render: true }
    }
    // The release is the gesture's last point: resolve the range against it.
    this.previewFocus = { row: hit.row, col: Math.max(0, event.x) }
    const range = this.previewSelectionRange()
    this.onResultsChanged?.()
    if (range === undefined) return { handled: true }
    const content = this.selected()?.content ?? ''
    const text = content.slice(range.start, range.end)
    if (text === '') return { handled: true }
    this.onCopy?.(text)
    return { handled: true, render: true }
  }

  /** Drop any in-flight pointer gesture and highlighted Preview selection (a
   *  park, a close, a resize and a screen swap all invalidate the frame it was
   *  taken against). */
  resetPointerGesture(): void {
    this.gesture = undefined
    this.resetPreviewSelection()
  }

  /** Open-time init: run the initial (empty-query) search immediately. */
  start(): void {
    if (this.disposed) return
    // `refresh()` never rejects: source failures land in the panel state and a
    // stale-subject page is dropped without any teardown call.
    void this.refresh() // allowlist: refresh() never rejects (see above)
  }

  /** Cancel and forget (called by the host through the seat lease). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Invalidate the generation: a source that ignores the abort and settles
    // LATE (resolve OR reject) must never commit into the closed panel — the
    // refresh's generation check is the fence for both paths.
    this.state.generation += 1
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    this.controller = undefined
    this.frame = undefined
    this.resetPointerGesture()
  }

  render(width: number): string[] {
    const layout = this.plan(width)
    const lines: string[] = []
    const hits: HistoryMouseHit[] = []
    const push = (line: string, hit: HistoryMouseHit): void => {
      lines.push(line)
      hits.push(hit)
    }
    const paintedResultIds = new Set<string>()
    let listTop: number | undefined
    let listBottom: number | undefined
    let previewTop: number | undefined
    let previewBottom: number | undefined
    let previewContentTop: number | undefined

    // Owner decision D15 (2026-10-14): the seat declares its own boundary with
    // the surrounding chrome — ONE `─` (role 15) as the first row and ONE as the
    // last row, BELOW the action bar. Both are decoration: the plan drops the
    // bottom rule first, then the top one, before any Preview region shrinks.
    if (layout.topRule) push(color.border('─'.repeat(layout.width)), { kind: 'inert' })
    if (layout.header) push(this.renderHeader(layout.width), { kind: 'inert' })
    if (layout.query) push(this.renderQueryRow(layout.width), { kind: 'search', xOffset: visibleWidth('Search: ') })

    const previewable = this.previewable()
    if (!previewable) {
      if (layout.resultsRows > 0) push(this.renderMessage(layout.width), { kind: 'inert' })
    } else {
      const list = this.renderList(layout.width, layout)
      listTop = lines.length
      for (const line of list.lines) push(line.text, line.hit)
      listBottom = lines.length - 1
      for (const id of list.paintedIds) paintedResultIds.add(id)
      if (layout.divider) push(color.border('─'.repeat(layout.width)), { kind: 'inert' })
      const preview = this.renderPreview(layout)
      previewTop = lines.length
      for (const line of preview) {
        if (line.kind === 'content' && previewContentTop === undefined) previewContentTop = lines.length
        push(line.text, line.hit)
      }
      previewBottom = lines.length - 1
    }
    if (layout.footer) push(this.renderFooter(layout.width), { kind: 'inert' })
    if (layout.bottomRule) push(color.border('─'.repeat(layout.width)), { kind: 'inert' })

    // A frame whose width or height moved: the painted rows, the pointer hit map
    // and the Preview drag coordinates all describe the OLD frame, so the
    // gesture/selection is dropped before this new frame is published.
    const previous = this.frame
    if (previous !== undefined && (previous.width !== layout.width || previous.height !== lines.length)) {
      this.resetPointerGesture()
    }
    this.frame = {
      width: layout.width,
      height: lines.length,
      generation: this.state.generation,
      hits,
      ...(listTop === undefined ? {} : { listTop, listBottom }),
      ...(previewTop === undefined ? {} : { previewTop, previewBottom }),
      ...(previewContentTop === undefined ? {} : { previewContentTop }),
      listPage: layout.listPage,
      paintedResultIds,
    }
    return lines
  }

  // ── layout ───────────────────────────────────────────────────────────────

  private plan(width: number): HistorySeatLayout {
    return planHistorySeatLayout(
      Math.max(1, Math.floor(width)),
      this.geometry.rows(),
      this.geometry.chromeRows(Math.max(1, Math.floor(width))),
      this.expanded,
      { previewable: this.previewable() },
    )
  }

  /** Whether a selectable result body exists (an error never previews a stale
   *  page; a pending query keeps painting the previous page, frozen for
   *  acceptance). */
  private previewable(): boolean {
    return this.state.error === undefined && this.state.results.length > 0
  }

  /** The layout width the last frame was painted at (falls back to the live
   *  terminal width before the first paint). */
  private lastWidth(): number {
    return this.frame?.width ?? Math.max(1, Math.floor(this.geometry.columns()))
  }

  // ── rendering ────────────────────────────────────────────────────────────

  private renderHeader(width: number): string {
    // Identity is Title Case, role 1 (`textStrong`); the leading/trailing blank
    // width of the old ` Input history ` is preserved.
    const title = ' Input History '
    const hint = `${HISTORY_CHORDS.expand.label} ${this.expanded ? 'collapse' : 'expand'}`
    const tabs = this.renderTabs(width)
    const headPlain = `${title}${tabs.plain}`
    const gap = width - visibleWidth(headPlain) - visibleWidth(hint)
    if (gap >= 2) {
      // Styles are applied AFTER the widths are resolved, so the line can never
      // exceed the frame. The F2 hint is role 13 (`textMuted`).
      return `${color.textStrong(title)}${tabs.styled}${' '.repeat(gap)}${color.textMuted(hint)}`
    }
    // Cramped: the F2 hint is removed WHOLE (never a partial `F2 exp…`); the
    // scope tabs keep their own ink while the head fits, and the head is
    // clamped plain only below the frozen 44-column matrix minimum.
    if (visibleWidth(headPlain) <= width) return `${color.textStrong(title)}${tabs.styled}`
    return color.textStrong(clampLine(headPlain, width))
  }

  /**
   * The scope tabs, responsive: wide terminals get the full Title Case labels
   * (`Current Session` / `Current Directory` / `All Directories`), narrow ones
   * the short forms (`Session` / `Directory` / `All`). Each Header paints
   * exactly ONE active scope as a bold-`primary` `[Label]`; the others are
   * `textDim`. The session tab exists only when a live session identity was
   * injected.
   */
  private renderTabs(width: number): { plain: string; styled: string } {
    const wide = width >= 85
    const sessionLabel = this.sessionId !== undefined ? (wide ? 'Current Session' : 'Session') : null
    const currentLabel = wide ? 'Current Directory' : 'Directory'
    const allLabel = wide ? 'All Directories' : 'All'
    const parts: Array<{ plain: string; styled: string }> = []
    const push = (scope: HistoryScope, label: string): void => {
      const active = this.state.scope === scope
      parts.push(active
        ? { plain: `[${label}]`, styled: color.textStrong(`[${label}]`, 'primary') }
        : { plain: ` ${label} `, styled: ` ${color.textDim(label)} ` })
    }
    if (sessionLabel !== null) push('session', sessionLabel)
    push('current', currentLabel)
    push('all', allLabel)
    return {
      plain: `  ${parts.map(part => part.plain).join(' ')}`,
      styled: `  ${parts.map(part => part.styled).join(' ')}`,
    }
  }

  private renderQueryRow(width: number): string {
    // The field label is role 5 (`textDim`); the Input paints its own real text
    // and cursor, which is never re-rendered or trimmed here.
    const label = 'Search: '
    const labelWidth = visibleWidth(label)
    const inputLines = this.input.render(Math.max(1, width - labelWidth))
    const first = inputLines[0] ?? ''
    return `${color.textDim(label)}${first}${' '.repeat(Math.max(0, width - labelWidth - visibleWidth(first)))}`
  }

  private renderMessage(width: number): string {
    const failed = this.state.error !== undefined
    const text = failed
      ? this.state.error!
      : this.state.loading ? 'Loading history…' : this.state.query === '' ? 'No history yet' : 'No matching history'
    // Role 16: the placeholder is `textDim`; a failed placeholder's word is
    // `error` (a no-match must never read as a failure).
    const plain = clampLine(`  ${text}`, width)
    return failed ? color.error(plain) : color.textDim(plain)
  }

  /** The results list: one single-line virtual window that FOLLOWS the
   *  selection (with a `Results · N matches` counter row when the region can
   *  keep a real result row with it). */
  private renderList(width: number, layout: HistorySeatLayout): {
    lines: Array<{ text: string; hit: HistoryMouseHit }>
    paintedIds: string[]
  } {
    const lines: Array<{ text: string; hit: HistoryMouseHit }> = []
    const paintedIds: string[] = []
    const count = this.state.results.length
    if (layout.resultsRows <= 0 || count === 0) return { lines, paintedIds }
    const counter = layout.resultsRows >= 2
    const visible = Math.max(1, layout.resultsRows - (counter ? 1 : 0))
    if (counter) {
      const matches = `${count} match${count === 1 ? '' : 'es'}`
      const plain = clampLine(`Results · ${matches}`, width)
      const cut = Math.min(visibleWidth('Results · '), visibleWidth(plain))
      lines.push({
        text: `${color.textDim(plain.slice(0, cut))}${color.textMuted(plain.slice(cut))}`,
        hit: { kind: 'inert' },
      })
    }
    // Viewport: center the selection, clamp to the ends — ↓ to row 150 of 200
    // must scroll the window, never hide the `> ` marker.
    const start = Math.max(0, Math.min(this.state.selectedIndex - Math.floor(visible / 2), count - visible))
    const end = Math.min(count, start + visible)
    for (let index = start; index < end; index += 1) {
      const result = this.state.results[index]
      if (result === undefined) continue
      const isSelected = index === this.state.selectedIndex
      // The row is ONE two-cell gutter (`> ` in `primary` when selected, two
      // blank cells otherwise), the secondary facts (`age`, and the All-dirs
      // directory) in `textDim`, and the prompt text as its own span — bold
      // `textStrong` when selected, `text` otherwise. The prefix spans keep the
      // B3-A geometry: the gutter is exactly two cells.
      const markerPlain = isSelected ? '> ' : '  '
      const agePlain = `${result.ts === null ? '   ' : formatRelativeAge(result.ts).padStart(3)} `
      const cwdPlain = this.state.scope === 'all' && result.cwd !== null
        ? `${shortCwd(result.cwd).padEnd(14)} `
        : ''
      const labelPlain = resultLabel(result.content)
      let remaining = width
      const take = (text: string, ellipsis = ''): string => {
        const clamped = truncateToWidth(text, remaining, ellipsis)
        remaining -= visibleWidth(clamped)
        return clamped
      }
      const marker = take(markerPlain)
      const age = take(agePlain)
      const cwd = take(cwdPlain)
      const label = take(labelPlain, '…')
      lines.push({
        text: `${isSelected ? color.primary(marker) : marker}${color.textDim(age)}${color.textDim(cwd)}`
          + (isSelected ? color.textStrong(label) : color.text(label)),
        hit: { kind: 'result', id: result.id },
      })
      paintedIds.push(result.id)
    }
    return { lines, paintedIds }
  }

  /** The Preview region: the heading (with its actions), the soft-wrapped
   *  ORIGINAL source rows and the trailing metadata. */
  private renderPreview(layout: HistorySeatLayout): Array<{
    kind: 'heading' | 'content' | 'metadata'
    text: string
    hit: HistoryMouseHit
  }> {
    const out: Array<{ kind: 'heading' | 'content' | 'metadata'; text: string; hit: HistoryMouseHit }> = []
    const selected = this.selected()
    const visual = this.previewLayoutAt(layout.width, selected?.content ?? '')
    const rows = visual.rows
    const maxTop = Math.max(0, rows.length - layout.previewRows)
    if (this.previewAnchorWidth !== layout.width) {
      // The wrap moved: re-derive the painted row from the SOURCE anchor so the
      // reader keeps the same text on screen (a raw row number would land on a
      // different passage).
      this.previewTop = previewRowAtOffset(visual, this.previewAnchorOffset)
      this.previewAnchorWidth = layout.width
    }
    this.previewTop = Math.max(0, Math.min(this.previewTop, maxTop))
    this.previewAnchorOffset = this.anchorOffsetOf(visual, this.previewTop)
    const range = this.previewSelectionRangeFor(visual)

    if (layout.previewHeading) {
      out.push(this.renderPreviewHeading(layout.width, rows.length, layout.previewRows, selected))
    }
    for (let offset = 0; offset < layout.previewRows; offset += 1) {
      const row = this.previewTop + offset
      const painted = rows[row]
      if (painted === undefined) {
        out.push({ kind: 'content', text: '', hit: { kind: 'inert' } })
        continue
      }
      out.push({
        kind: 'content',
        text: this.stylePreviewRow(visual, painted, row, range),
        hit: { kind: 'preview', row },
      })
    }
    if (layout.metadata) {
      out.push({ kind: 'metadata', text: this.renderMetadata(layout.width, selected), hit: { kind: 'inert' } })
    }
    return out
  }

  /**
   * The Preview heading: the fixed `Preview` label (role 2, `textDim`) plus the
   * `rows X-Y/N` count (role 12, `textMuted`) when available. On the regular
   * main screen the keyboard hint (`Alt+C copy · Enter use`) replaces the
   * fullscreen affordances — never a fake mouse target. In Fullscreen the two
   * verbs are role-14 `primary` affordances, WITHOUT brackets, each carrying its
   * key badge and painted only while the whole item fits; the count yields
   * first. Every clickable cell range is resolved from the final painted plain
   * width (never a pre-clamp string length).
   */
  private renderPreviewHeading(
    width: number,
    totalRows: number,
    previewRows: number,
    selected: HistorySearchResult | undefined,
  ): { kind: 'heading'; text: string; hit: HistoryMouseHit } {
    const first = totalRows === 0 ? 0 : this.previewTop + 1
    const last = Math.min(totalRows, this.previewTop + previewRows)
    const position = totalRows === 0 ? '' : `rows ${first}-${last}/${totalRows}`
    const label = 'Preview'

    if (!this.pointerEnabled() || selected === undefined) {
      const hint = `${HISTORY_CHORDS.copy.label} copy · ${HISTORY_CHORDS.accept.label} use`
      const build = (withPosition: boolean, withHint: boolean): { plain: string; styled: string } => {
        const plain: string[] = [label]
        const styled: string[] = [color.textDim(label)]
        if (withPosition && position !== '') { plain.push(position); styled.push(color.textMuted(position)) }
        if (withHint) { plain.push(hint); styled.push(color.textMuted(hint)) }
        return { plain: plain.join('  '), styled: styled.join('  ') }
      }
      const chosen = [
        build(true, true),
        build(false, true),
        build(true, false),
        build(false, false),
      ].find(candidate => visibleWidth(candidate.plain) <= width) ?? { plain: label, styled: color.textDim(label) }
      // Only a sub-`Preview`-wide frame reaches this clamp (below the frozen
      // 44-column matrix minimum); every painted row must stay inside the frame.
      const plain = visibleWidth(chosen.plain) <= width ? chosen.plain : truncateToWidth(chosen.plain, width, '')
      return { kind: 'heading', text: plain === chosen.plain ? chosen.styled : color.textDim(plain), hit: { kind: 'inert' } }
    }

    const copyText = `Copy All [${HISTORY_CHORDS.copy.label}]`
    const useText = `Use Selected [${HISTORY_CHORDS.accept.label}]`
    const build = (withPosition: boolean, withCopy: boolean, withUse: boolean): { plain: string; styled: string } => {
      const plain: string[] = [label]
      const styled: string[] = [color.textDim(label)]
      if (withPosition && position !== '') { plain.push(position); styled.push(color.textMuted(position)) }
      if (withCopy) { plain.push(copyText); styled.push(color.primary(copyText)) }
      if (withUse) { plain.push(useText); styled.push(color.primary(useText)) }
      return { plain: plain.join('  '), styled: styled.join('  ') }
    }
    // Degradation: the count yields first, then `Use Selected`, then `Copy All`.
    const chosen = [
      build(true, true, true),
      build(false, true, true),
      build(false, true, false),
      build(true, false, false),
      build(false, false, false),
    ].find(candidate => visibleWidth(candidate.plain) <= width) ?? { plain: label, styled: color.textDim(label) }
    // Only a sub-`Preview`-wide frame reaches this clamp (below the frozen
    // 44-column matrix minimum); every painted row must stay inside the frame.
    const plain = visibleWidth(chosen.plain) <= width ? chosen.plain : truncateToWidth(chosen.plain, width, '')
    const actions: Array<{ from: number; to: number; action: HistoryPointerAction }> = []
    const copyFrom = plain.indexOf(copyText)
    if (copyFrom >= 0) {
      actions.push({ from: copyFrom, to: copyFrom + visibleWidth(copyText), action: { kind: 'copyAll', id: selected.id } })
    }
    const useFrom = plain.indexOf(useText)
    if (useFrom >= 0) {
      actions.push({ from: useFrom, to: useFrom + visibleWidth(useText), action: { kind: 'useSelected', id: selected.id } })
    }
    return {
      kind: 'heading',
      text: plain === chosen.plain ? chosen.styled : color.textDim(plain),
      hit: actions.length === 0 ? { kind: 'inert' } : { kind: 'actions', actions },
    }
  }

  private renderMetadata(width: number, selected: HistorySearchResult | undefined): string {
    const scope = this.state.scope === 'session' ? 'session' : this.state.scope === 'current' ? 'directory' : 'all'
    const parts = [`Scope: ${scope}`]
    if (selected?.cwd != null) parts.push(`Directory: ${sanitizedPhysicalLine(shortCwd(selected.cwd))}`)
    if (selected?.ts != null) parts.push(`Time: ${formatHistoryTime(selected.ts)}`)
    else parts.push('Time unknown')
    if (selected?.sessionId !== undefined) parts.push(`Session: ${sanitizedPhysicalLine(selected.sessionId)}`)
    // Role 11 (diagnostic facts): labels and facts are `textDim`; this is an
    // inline fact line, so it never carries the standalone status marker.
    return color.textDim(clampLine(`  ${parts.join(' · ')}`, width))
  }

  private renderFooter(width: number): string {
    // The History-LOCAL Action Bar: the shared `renderActionBarRow` algorithm
    // (compact a declared `short` first, then drop whole segments by ascending
    // priority, `Esc` last and never dropped), driven by the ONE chord table so
    // every hint names the same key its handler matches.
    const segments: ActionBarSegment[] = [
      { text: `${HISTORY_CHORDS.accept.label} use`, priority: 100 },
      { text: `${HISTORY_CHORDS.scope.label} scope`, priority: 65 },
      { text: `${HISTORY_CHORDS.results.label} results`, priority: 50, short: HISTORY_CHORDS.results.label },
      { text: `${HISTORY_CHORDS.preview.label} preview`, priority: 35, short: HISTORY_CHORDS.preview.label },
      { text: `${HISTORY_CHORDS.copy.label} copy`, priority: 55 },
      { text: `${HISTORY_CHORDS.expand.label} ${this.expanded ? 'collapse' : 'expand'}`, priority: 30 },
      { text: `${HISTORY_CHORDS.cancel.label} cancel`, priority: 1000 },
    ]
    return color.textMuted(renderActionBarRow(segments, width))
  }

  /** One Preview source row, with the drag-selected source CELLS inverted. The
   *  row is already ≤ width (the neutral builder wraps it), so the styled string
   *  needs no further clamp. */
  private stylePreviewRow(
    visual: SourceTextVisualLayout,
    painted: SourceTextVisualRow,
    row: number,
    range: { readonly start: number; readonly end: number } | undefined,
  ): string {
    if (range === undefined) return painted.rendered
    const columns = sourceTextRowSelectionColumns(visual, row, range.start, range.end)
    if (columns === undefined) return painted.rendered
    let out = ''
    for (const run of painted.runs) {
      const selected = run.endCol > columns.startCol && run.startCol < columns.endCol
      out += selected ? `\x1b[7m${run.display}\x1b[27m` : run.display
    }
    return out
  }

  // ── navigation ───────────────────────────────────────────────────────────

  private toggleScope(): void {
    this.state.scope = this.sessionId !== undefined
      ? this.state.scope === 'session' ? 'current'
        : this.state.scope === 'current' ? 'all'
          : 'session'
      : this.state.scope === 'current' ? 'all' : 'current'
    this.state.selectedIndex = 0
    this.scheduleSearch()
  }

  private moveSelection(data: string): void {
    const count = this.state.results.length
    if (count === 0) return
    const index = this.state.selectedIndex
    if (matchesKey(data, 'up')) this.state.selectedIndex = index === 0 ? count - 1 : index - 1
    else if (matchesKey(data, 'down')) this.state.selectedIndex = index === count - 1 ? 0 : index + 1
    else {
      // The page step is the ACTUAL painted result-row count (never a hardcoded
      // six).
      const page = Math.max(1, this.plan(this.lastWidth()).listPage)
      if (matchesKey(data, 'pageUp')) this.state.selectedIndex = Math.max(0, index - page)
      else this.state.selectedIndex = Math.min(count - 1, index + page)
    }
    this.reanchorPreview()
  }

  private movePreview(data: string): void {
    const layout = this.plan(this.lastWidth())
    if (layout.previewRows <= 0) return
    const selected = this.selected()
    const rows = selected === undefined ? 0 : this.previewLayoutAt(layout.width, selected.content).rows.length
    const maxTop = Math.max(0, rows - layout.previewRows)
    const page = Math.max(1, layout.previewRows)
    if (matchesKey(data, 'alt+up')) this.previewTop -= 1
    else if (matchesKey(data, 'alt+down')) this.previewTop += 1
    else if (matchesKey(data, 'alt+pageUp')) this.previewTop -= page
    else if (matchesKey(data, 'alt+pageDown')) this.previewTop += page
    else if (matchesKey(data, 'alt+home')) this.previewTop = 0
    else this.previewTop = maxTop
    this.previewTop = Math.max(0, Math.min(this.previewTop, maxTop))
    this.syncPreviewAnchor(layout.width, selected?.content ?? '')
    this.onResultsChanged?.()
  }

  /** A NEW selected result starts its Preview at the top; a repaint of the SAME
   *  result keeps the manual scroll position. */
  private reanchorPreview(): void {
    const id = this.selected()?.id
    if (id === this.previewResultId) return
    this.previewResultId = id
    this.previewTop = 0
    this.previewAnchorOffset = 0
    this.resetPreviewSelection()
  }

  private resetPreviewSelection(): void {
    this.previewAnchor = undefined
    this.previewFocus = undefined
  }

  private previewSelectionRange(): { readonly start: number; readonly end: number } | undefined {
    const content = this.selected()?.content ?? ''
    return this.previewSelectionRangeFor(this.previewLayoutAt(this.lastWidth(), content))
  }

  /** The same resolution against an EXPLICIT layout (the one a frame was built
   *  from), so a repaint can never mix two widths. */
  private previewSelectionRangeFor(visual: SourceTextVisualLayout): { readonly start: number; readonly end: number } | undefined {
    const anchor = this.previewAnchor
    const focus = this.previewFocus
    if (anchor === undefined || focus === undefined) return undefined
    return sourceTextSelectionRange(visual, anchor, focus)
  }

  /** Re-anchor the Preview to its new first painted row after a scroll. */
  private syncPreviewAnchor(width: number, content: string): void {
    const visual = this.previewLayoutAt(width, content)
    this.previewAnchorOffset = this.anchorOffsetOf(visual, this.previewTop)
    this.previewAnchorWidth = width
  }

  /** The source offset of the first painted source row (the resize anchor). */
  private anchorOffsetOf(visual: SourceTextVisualLayout, top: number): number {
    return sourceTextPointOffset(visual, { row: top, col: 0 }, 'start') ?? 0
  }

  /** The cached Preview layout at one width: rebuilt only when the selected
   *  source or the width changed, so the offsets a gesture resolves against are
   *  exactly the ones the painted rows were built from. */
  private previewLayoutAt(width: number, content: string): SourceTextVisualLayout {
    const safeWidth = Math.max(1, Math.floor(width))
    const cached = this.previewLayout
    if (cached !== undefined && cached.width === safeWidth && cached.source === content) return cached
    const layout = buildSourceTextVisualLayout(content, safeWidth)
    this.previewLayout = layout
    return layout
  }

  private actionAt(
    hit: Extract<HistoryMouseHit, { kind: 'actions' }>,
    x: number,
  ): HistoryPointerAction | undefined {
    for (const entry of hit.actions) {
      if (x >= entry.from && x < entry.to) return entry.action
    }
    return undefined
  }

  private handleWheel(event: TuiMouseEvent, frame: HistoryMouseFrame): TuiMouseEventResult | undefined {
    const delta = event.wheelDelta ?? 0
    if (delta === 0) return undefined
    const inList = frame.listTop !== undefined && frame.listBottom !== undefined
      && event.y >= frame.listTop && event.y <= frame.listBottom
    if (inList) {
      const count = this.state.results.length
      if (count === 0) return undefined
      const step = delta > 0 ? 1 : -1
      const index = this.state.selectedIndex
      this.state.selectedIndex = step < 0
        ? index === 0 ? count - 1 : index - 1
        : index === count - 1 ? 0 : index + 1
      this.reanchorPreview()
      return { handled: true, render: true }
    }
    const inPreview = frame.previewTop !== undefined && frame.previewBottom !== undefined
      && event.y >= frame.previewTop && event.y <= frame.previewBottom
    if (!inPreview) return undefined
    const layout = this.plan(frame.width)
    const content = this.selected()?.content ?? ''
    const rows = this.previewLayoutAt(layout.width, content).rows.length
    const maxTop = Math.max(0, rows - layout.previewRows)
    this.previewTop = Math.max(0, Math.min(this.previewTop + delta, maxTop))
    this.syncPreviewAnchor(layout.width, content)
    return { handled: true, render: true }
  }

  // ── actions ──────────────────────────────────────────────────────────────

  private acceptSelected(): void {
    // The ONE acceptance predicate: a stale page, a pending query, an error or
    // an unpainted row all refuse (the host re-validates its own subject after
    // this call).
    if (!this.canAccept()) return
    const selected = this.selected()
    if (selected === undefined) return
    // The identity AND the exact bytes leave this component together; the host
    // owns the seat teardown, so no second close path exists here.
    this.onAccept({ id: selected.id, content: selected.content })
  }

  private copyAll(): void {
    const selected = this.selected()
    if (selected === undefined || !this.canAcceptCopy()) return
    // Copy All is the EXACT stored prompt — never a rendered/truncated row.
    this.onCopy?.(selected.content)
  }

  /** Copy All may run while a query is still settling (it copies the row the
   *  user can see), but never for an unpainted or stale selection. */
  private canAcceptCopy(): boolean {
    if (this.disposed || this.state.error !== undefined || !this.tenantIsCurrent()) return false
    const selected = this.selected()
    if (selected === undefined) return false
    return this.frame?.paintedResultIds.has(selected.id) === true
  }

  /**
   * Drop an in-flight page whose captured subject is no longer current: it
   * belongs to a previous session, so it is neither published nor acted on. The
   * pending state still ends and the seat repaints through the ORDINARY result
   * channel — a "Loading history…" row that this drop invalidated must never stay
   * painted. This does NOT retire the seat: the lifecycle stays CALLER-owned (the
   * host's next revalidation entry retires a stale tenant through its ONE close
   * path), and a synchronous teardown call here would be the only way `refresh()`
   * could reject — the fire-and-forget search contract is that it never does.
   */
  private dropStalePage(): void {
    this.state.loading = false
    this.onResultsChanged?.()
  }

  private scheduleSearch(): void {
    // The query/scope changed NOW: invalidate the in-flight generation and
    // abort its request IMMEDIATELY — a response that lands during the debounce
    // window must never commit results for the PREVIOUS query.
    this.state.generation += 1
    this.controller?.abort()
    this.controller = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh() // allowlist: refresh() never rejects (errors land in the panel state)
    }, this.debounceMs)
    // The first keystroke shows loading immediately (the debounce only delays
    // the file reads, not the state flip). A visible previous page stays painted
    // — acceptance is frozen until this new search settles.
    if (!this.state.loading) {
      this.state.loading = true
      this.onResultsChanged?.()
    }
  }

  /** Run one search with the CURRENT query/scope; commit only when this
   *  generation is still live (stale results are dropped). */
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
      sessionId: this.sessionId,
      query: this.state.query,
      limit: HISTORY_SEARCH_RESULT_LIMIT,
      signal: controller.signal,
    }
    let results: HistorySearchResult[]
    try {
      const page = await this.source.search(request)
      results = page.results
    } catch {
      // Second fence for a late failure: the generation was invalidated by
      // scheduleSearch/dispose, and the abort was requested — an abort-ignoring
      // source must not paint "History unavailable" into a panel that no longer
      // owns this query.
      if (generation !== this.state.generation || controller.signal.aborted) return
      // A previous subject's failure is not this session's "History
      // unavailable": drop it silently (the seat keeps its current rows).
      if (!this.tenantIsCurrent()) return this.dropStalePage()
      this.state.loading = false
      this.state.error = 'History unavailable'
      this.state.results = []
      this.state.selectedIndex = 0
      this.onResultsChanged?.()
      return
    }
    if (generation !== this.state.generation || controller.signal.aborted) return
    // The result page belongs to the session captured at open: a subject that
    // moved while this search was in flight must never publish another
    // session's rows into the visible History.
    if (!this.tenantIsCurrent()) return this.dropStalePage()
    // The stable ID survives a recompute when it is still in the new page; the
    // first valid match is the fallback.
    const previous = this.selected()?.id
    this.state.results = results
    this.state.loading = false
    const restored = previous === undefined ? -1 : results.findIndex(candidate => candidate.id === previous)
    this.state.selectedIndex = restored >= 0 ? restored : 0
    if (restored < 0 || previous === undefined) this.reanchorPreview()
    this.onResultsChanged?.()
  }
}
