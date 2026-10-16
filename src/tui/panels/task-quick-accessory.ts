/**
 * Task Quick — the on-demand task accessory below the editor (Phase 3B /
 * B4-A passive projection + B4-B interaction).
 *
 * Anatomy while ACTIVE (ONE vertical presentation at every width — a single
 * `render(width)` decides the layout):
 * - Identity row: `Task Quick` (role 1, bold `textStrong`) with the right-aligned
 *   position `showing x-y/N` (role 12, `textMuted`);
 * - Up to three single-line task rows: the selection marker `> ` (`primary`,
 *   D6's ONE active device) for the selected row, the projected row label
 *   (role 3 `text`, ancestor-context rows role 4 `textDim`), the durable mode
 *   suffix (role 4) and the status group `‣ Running` (role 9, `taskStatusColor`
 *   ink + `taskStatusWord` word);
 * - A granted-one-row frame spends its ONLY row on task content and moves the
 *   compact `x-y/N` to that row's tail — a header never displaces a task row.
 *
 * HIDDEN (unfocused) paints ZERO rows (B4-B, Owner revision 2026-10-14): no
 * body, no header, no blank band — even with live tasks. `focused` is the
 * ONLY visibility authority; the host's keymap-admitted `↓` (and a
 * Fullscreen same-row click) are the only paths in, and Esc / Up-at-first /
 * commit / owner displacement are the paths out.
 *
 * The component is a projection surface: it owns the row window, the
 * ephemeral selection, the keyboard surface and the Fullscreen pointer
 * surface while ACTIVE. It never reads a Job/Question/Host source, never
 * opens a surface itself (the host's typed callback does), never
 * acknowledges a failure and never paints without real focus.
 *
 * Row budget while ACTIVE: the accessory is the lowest-priority first-party
 * pinned decoration. Its grant is derived from the LIVE frame — the terminal
 * rows, the pinned chrome the host measures for it, and exactly one visible
 * transcript row — and is additionally capped by its own proportional share
 * of the terminal height and by `TASK_QUICK_MAX_ROWS`. It is never a fixed
 * terminal-size threshold, and it never borrows a row from the editor seat,
 * the footer, the public widget zones or the transcript floor. A 0-grant
 * frame cannot be entered (the host declines).
 *
 * Visual vocabulary is frozen by `docs/tui-design-language.md` (§3.2 role
 * table, §4.3/§4.4 glyph inventory): one `‣` marker and a Title Case status
 * word, `> ` as the only active marker, no cursor glyph, no brackets, no
 * second palette token, no frame/border — plus the ONE Owner-authorized top
 * separator rule (role 15 `border`) that marks the Footer↔Quick boundary
 * (§6.2 exception) and yields to task rows on a low budget.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/task-quick-accessory
 */

import { truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { componentKeymap } from '../keybindings/component-keymap.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color, taskStatusColor, taskStatusWord } from '../theme/runtime.ts'
import type { TaskPanelItem } from '../../app/surface/task-presentation.ts'

/** The accessory's own row ceiling: identity row + three task rows. This is
 *  the accessory's budget, never a terminal-size threshold. */
export const TASK_QUICK_MAX_ROWS = 5
/** The item-row ceiling: at most three single-line task rows at any size. */
export const TASK_QUICK_MAX_ITEM_ROWS = 3
/** The shared status marker (design language §4.4, D5+D7) — one `‣` and a word. */
const STATUS_MARKER = '‣'
/** The identity of the accessory (role 1; Title Case, never ALL-CAPS). */
const TASK_QUICK_IDENTITY = 'Task Quick'

/** The live geometry seam the host injects: the terminal size and the rows the
 *  OTHER pinned chrome currently occupies. `chromeRows` EXCLUDES this accessory
 *  itself (measuring it from inside its own render would be cyclic) and includes
 *  the editor seat, the footer and the public widget zones at their live grant,
 *  so the accessory's budget always follows the real frame. */
export interface TaskQuickGeometry {
  /** Live terminal columns. */
  readonly columns: () => number
  /** Live terminal rows. */
  readonly rows: () => number
  /** The rows the pinned non-Quick chrome occupies at `width`. */
  readonly chromeRows: (width: number) => number
}

/** The row plan of one accessory frame. */
export interface TaskQuickLayout {
  /** The width every painted row is clamped to. */
  readonly width: number
  /** The maximum number of rows the accessory may paint (`0` = nothing fits). */
  readonly grant: number
  /** Whether the identity/position row is painted. */
  readonly header: boolean
  /** Whether the Quick-owned top separator rule is painted. It is the ONLY
   *  rule on this surface (the Owner-authorized Footer↔Quick boundary,
   *  design language §6.2 exception) and it yields to task rows: painted
   *  only when every projected task row already fits. */
  readonly separator: boolean
  /** The capacity of the task-row window (the paging/anchor step). */
  readonly itemRows: number
  /** The first visible item index. */
  readonly start: number
  /** The number of task rows actually painted from `start`. */
  readonly count: number
  /** The total number of projected items (`N`). */
  readonly total: number
}

/** A frame with nothing to paint (0 grant or 0 items). */
function emptyLayout(width: number, total: number): TaskQuickLayout {
  return { width, grant: 0, header: false, separator: false, itemRows: 0, start: 0, count: 0, total }
}

/**
 * Derive the accessory's row plan from the LIVE frame (B4-B addendum
 * 2026-10-15: the band is under the whole footer and owns ONE top separator):
 *
 * 1. `desired = min(3, N)` — the real projected row count, never a fabricated
 *    one; an empty projection paints nothing at all;
 * 2. `share = floor(terminalRows / 4)` — the accessory's proportional share of
 *    the terminal height, the same shape as the public below-widget zone's cap;
 * 3. `room = terminalRows - chromeRows - 1` — every other owner first (the
 *    footer included — the band sits UNDER it), plus one visible transcript row;
 * 4. `grant = min(5, share, room, desired + 2)` — at least one TASK row is the
 *    first guarantee; the identity row follows the B4-A rule (a ≥2 grant with
 *    task rows to spare); the separator is DECORATIVE and painted only when
 *    every projected task row already fits (`grant >= desired + 2`) — a rule
 *    line never displaces a visible task row.
 */
export function planTaskQuickLayout(
  terminalCols: number,
  terminalRows: number,
  chromeRows: number,
  total: number,
  startIndex: number,
): TaskQuickLayout {
  const width = Math.max(1, Math.floor(Number.isFinite(terminalCols) ? terminalCols : 1))
  const rows = Math.max(1, Math.floor(Number.isFinite(terminalRows) ? terminalRows : 1))
  const chrome = Math.max(0, Math.floor(Number.isFinite(chromeRows) ? chromeRows : 0))
  const items = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0))
  const desired = Math.min(TASK_QUICK_MAX_ITEM_ROWS, items)
  if (desired === 0) return emptyLayout(width, 0)
  const share = Math.floor(rows / 4)
  const room = rows - chrome - 1
  const grant = Math.max(0, Math.min(TASK_QUICK_MAX_ROWS, share, room, desired + 2))
  if (grant === 0) return emptyLayout(width, items)
  const header = grant >= 2
  // The decorative separator yields to task rows: only when the grant covers
  // the identity row AND every projected task row with one row to spare.
  const separator = header && grant >= desired + 2
  const capacity = Math.min(desired, header ? grant - 1 : grant)
  const requested = Math.floor(Number.isFinite(startIndex) ? startIndex : 0)
  const start = Math.min(Math.max(0, requested), Math.max(0, items - capacity))
  return {
    width,
    grant,
    header,
    separator,
    itemRows: capacity,
    start,
    count: Math.min(capacity, items - start),
    total: items,
  }
}

/** Truncate one rendered row to the accessory width and pad it with plain
 *  spaces (a pinned row must never over-paint its own cells). */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

/** Whether `left` and `right` coexist on one row without cutting either. */
function fits(left: string, right: string, width: number): boolean {
  return visibleWidth(left) + 1 + visibleWidth(right) <= width
}

/** The identity row: role 1 left, role 12 right. The position region is the
 *  first thing to yield (whole, never truncated — design language §8.6), and it
 *  degrades from `showing x-y/N` to the compact `x-y/N` before it is dropped. */
function renderHeaderRow(width: number, start: number, count: number, total: number): string {
  const identity = color.textStrong(TASK_QUICK_IDENTITY)
  const range = `${start + 1}-${start + count}/${total}`
  for (const position of [`showing ${range}`, range]) {
    const right = color.textMuted(position)
    if (!fits(identity, right, width)) continue
    const gap = width - visibleWidth(identity) - visibleWidth(right)
    return identity + ' '.repeat(gap) + right
  }
  return fit(identity, width)
}

/**
 * One task row: `[selection marker]label[ · mode]` + the status group, and —
 * in the granted-one-row frame — the compact position at the tail.
 *
 * The selection marker (B4-B) is the ONLY active device (design language
 * D6): `> ` in the `primary` ink, painted only for the row whose stable
 * `value` is the current selection. It never introduces a second marker
 * glyph set and never re-inks the status word.
 *
 * Sacrifice order (plan §5.2): elapsed/description/details are never painted at
 * all, then the LABEL truncates with `…`, while the durable mode suffix, the
 * status word and the position are kept whole. The mode is dropped whole rather
 * than cut mid-word when the row cannot hold it beside one identifiable label
 * cell; the status word and the position are only ever cut below the frozen
 * 44-column matrix floor.
 *
 * Nesting is painted as INDENTATION derived from the durable depth, never as the
 * modal panel's `├─ ` connector: U+2500 is East-Asian-Width ambiguous, and the
 * design language forbids putting an ambiguous glyph in a NEW place
 * (`docs/tui-design-language.md` §4.3). The status word is projected through the
 * same single-physical-line sanitizer as the label: a status is an external
 * (possibly Remote/wire) string, and this row is budgeted as exactly one
 * terminal row.
 */
function renderItemRow(item: TaskPanelItem, width: number, position?: string, selected = false): string {
  const statusText = `${STATUS_MARKER} ${sanitizedPhysicalLine(taskStatusWord(item.status))}`
  const status = taskStatusColor(item.status)(statusText)
  const marker = selected ? color.primary('> ') : '  '
  const tail = position === undefined ? status : `${status}  ${color.textMuted(position)}`
  const tailWidth = visibleWidth(position === undefined ? statusText : `${statusText}  ${position}`)
  if (tailWidth >= width) return fit(`${marker}${tail}`, width)
  const room = width - tailWidth - visibleWidth(marker) - 1
  const indent = '  '.repeat(Math.max(0, Math.floor(item.depth ?? 0)))
  const indentWidth = visibleWidth(indent)
  const suffixText = item.suffix === undefined || item.suffix === '' ? '' : ` · ${item.suffix}`
  const suffixWidth = visibleWidth(suffixText)
  // The durable mode rides as a non-truncatable suffix: it is kept only while
  // the label still owns at least one identifiable cell after it.
  const suffix = suffixWidth > 0 && indentWidth + suffixWidth + 1 <= room ? suffixText : ''
  const labelBudget = Math.max(0, room - indentWidth - visibleWidth(suffix))
  const label = truncateToWidth(sanitizedPhysicalLine(item.label), labelBudget, '…', false)
  // B4-B addendum §1: the selected row's label paints `textStrong` (bold
  // role 1); unselected rows keep `text`/`textDim` by context.
  const ink = selected
    ? color.textStrong
    : item.ancestorContext === true ? color.textDim : color.text
  const left = `${marker}${color.textDim(indent)}${ink(label)}${color.textDim(suffix)}`
  const gap = Math.max(1, width - visibleWidth(left) - tailWidth)
  return `${left}${' '.repeat(gap)}${tail}`
}

/**
 * One painted task row of the last painted ACTIVE frame (mouse hit-testing).
 * The map is built from the EXACT final rows render() returns, so a click
 * can only act on last-painted geometry. The identity is the row's stable
 * `value` — never the physical index (an async reorder between press and
 * release must not activate whatever moved into the row).
 */
interface TaskQuickHit {
  readonly kind: 'item' | 'identity' | 'inert'
  readonly value?: string
}

/**
 * The last painted frame — the ONLY geometry a pointer event may resolve
 * against (a resize between paint and event must reject, never re-derive).
 */
interface TaskQuickPainted {
  readonly width: number
  /** The physical row count this frame painted (the hit box height). */
  readonly height: number
  /** The painted task-row count — the wheel window. */
  readonly itemRows: number
  /** The per-row hit identities of THIS frame (length === height). */
  readonly hits: readonly TaskQuickHit[]
  /** The LIVE terminal geometry this frame was painted for. The pi-tui alt
   *  screen builds a pointer event's own box dimensions from its last painted
   *  layout, so after a resize the event still carries the OLD dimensions:
   *  comparing the live geometry at dispatch time is the fence that can
   *  actually detect "this frame was painted for another terminal". */
  readonly terminalColumns: number
  readonly terminalRows: number
}

/**
 * The Task Quick accessory (Phase 3B / B4-A passive projection + B4-B
 * on-demand interaction).
 *
 * `focused` is the ONLY visibility authority (B4-A kept the band always
 * painted; B4-B retires that default per the Owner's 2026-10-14 revision):
 * an unfocused accessory paints ZERO rows — no header, no blank band — and
 * cuts its stale painted hit geometry at the same moment. The host owns the
 * whole admission/exit lifecycle (`enterTaskQuick` / `leaveTaskQuick`); the
 * component never claims focus itself and never fabricates an `open` flag.
 *
 * While ACTIVE the component owns: the row window (anchor + bounded
 * fallback), the selected row (an ephemeral stable `value` — never a label
 * or an index), the keyboard surface (`tasks.cursorUp/Down/pageUp/pageDown/
 * open/search.exit` through the shared component keymap), and the Fullscreen
 * pointer surface (the B4-A wheel window plus the B4-B same-row
 * press/release click). It holds no timer, no subscription and no catalog:
 * a data commit only re-anchors the window, reconciles the selection, and
 * asks for one repaint.
 *
 * Every unlisted key is consumed as a no-op while focused: nothing leaks to
 * the background editor, nothing submits, and no retired modal action is
 * dispatched.
 */
export class TaskQuickAccessory implements Component, Focusable {
  private items: TaskPanelItem[] = []
  /** The durable window anchor: the first visible row's stable value. */
  private firstVisibleId: string | undefined
  /** The bounded index fallback used when the anchor row disappeared. */
  private start = 0
  private painted: TaskQuickPainted | undefined
  private readonly geometry: TaskQuickGeometry
  private readonly requestRender: () => void
  /** The host-owned lifecycle callbacks (B4-B). `onExit` leaves Quick
   *  (Up at the global first row / Esc); `onActivate` commits the typed
   *  selection (Enter / same-row click) AFTER the host has already left
   *  Quick; `onEmpty` lets the host exit when the ACTIVE projection empties
   *  (fired only while this component really holds focus). */
  private readonly onExit: () => void
  private readonly onActivate: (value: string) => void
  private readonly onEmpty: () => void
  /** Invoked ONCE on the first render pass (render runs every frame even
   *  while HIDDEN — it returns [] — so the first call is the first frame).
   *  The host recomposes its footer hint then: the Down admission's
   *  painted-frame guard (X063) is live only from the first paint on, and a
   *  projection committed before that frame would otherwise leave the hint
   *  stale until unrelated churn. */
  private readonly onFirstPaint: () => void
  private firstPaintNotified = false
  /** The selected row's stable value while ACTIVE (ephemeral: never
   *  restored across open/close — a fresh entry always selects the first
   *  row). The selected INDEX is derived on demand from this value. */
  private selectedValue: string | undefined
  /** A wheel target is pending paint. Enter keeps the last-painted selection
   *  until render() commits its matching row. */
  private wheelSelectionPending = false
  /** The pressed row identity of an in-flight Fullscreen press→release
   *  gesture, bound to the painted frame the press happened on. Component-
   *  local, short-lived, cleared on every release and by `deactivate()`. */
  private pressedValue: string | undefined
  /** The painted frame the press happened on: a repaint (any reflow, a
   *  resize, a row insertion/removal) invalidates the in-flight gesture —
   *  the user pressed a row they SAW, and the row the frame now shows at
   *  that cell is not the row they pressed (addendum §2.4 stale-intent
   *  negative control). The click branch requires the latch AND its frame
   *  to be the CURRENT painted frame. */
  private pressedFrame: {
    readonly width: number
    readonly height: number
    readonly terminalColumns: number
    readonly terminalRows: number
    readonly first: string | undefined
  } | undefined

  focused = false

  constructor(options: {
    readonly geometry: TaskQuickGeometry
    readonly onRequestRender: () => void
    readonly onExit: () => void
    readonly onActivate: (value: string) => void
    readonly onEmpty: () => void
    readonly onFirstPaint: () => void
  }) {
    this.geometry = options.geometry
    this.requestRender = options.onRequestRender
    this.onExit = options.onExit
    this.onActivate = options.onActivate
    this.onEmpty = options.onEmpty
    this.onFirstPaint = options.onFirstPaint
  }

  /** The live projected rows (host diagnostics + the grant probe). */
  getItems(): readonly TaskPanelItem[] {
    return this.items
  }

  /**
   * Enter ACTIVE selection: select the GLOBAL first row and report whether a
   * real row was selectable. NEVER writes `focused` — the host's
   * `setFocus(taskQuick)` is the only focus writer (plan §5). Returning
   * `false` means no row was selectable (0 items), so the host must DECLINE
   * the entry and leave the editor's own Down in place.
   */
  activate(): boolean {
    const first = this.items[0]
    if (first === undefined) return false
    this.wheelSelectionPending = false
    this.selectedValue = first.value
    return true
  }

  /**
   * Leave ACTIVE: release the transient pointer/selection intent. Task
   * facts (the projected rows) are NOT cleared — an unfocused accessory
   * keeps its data and paints nothing.
   */
  deactivate(): void {
    this.selectedValue = undefined
    this.wheelSelectionPending = false
    this.pressedValue = undefined
    this.pressedFrame = undefined
  }

  /**
   * Replace the projected rows. The window first rebases onto the SAME row
   * identity it showed before: status updates do not reset it, and insertion
   * or removal keeps a surviving first-visible row. While ACTIVE, a
   * surviving selection normally remains visible; a pending wheel target takes
   * precedence until render() clamps selection into that window. A vanished
   * anchor falls back to the bounded previous index, never to a label guess.
   *
   * While ACTIVE the selected identity is reconciled against the new rows:
   * a surviving selection keeps its stable value; a deleted
   * selection falls back bounded to the successor of its pre-delete global
   * index (predecessor at the tail), and an emptied projection notifies the
   * host — ONLY while this component really holds the active focus (a
   * HIDDEN accessory's empty commit is a data-only update and must never
   * re-enter the host's focus lifecycle).
   *
   * An empty projection keeps the LAST PAINTED hit geometry until `render()`
   * actually paints the blank frame: the rows are still on screen, so a wheel
   * dispatched to that band before the deferred repaint must be consumed by the
   * accessory (not fall through to the transcript). `render()` clears the
   * geometry on the zero-row path.
   */
  setItems(next: readonly TaskPanelItem[]): void {
    const items = [...next]
    if (items.length === 0) {
      const wasActive = this.focused
      this.items = []
      this.firstVisibleId = undefined
      this.start = 0
      this.selectedValue = undefined
      this.wheelSelectionPending = false
      this.requestRender()
      // The host notification is deliberate LAST: the component state is
      // already consistent if the host re-enters synchronously.
      if (wasActive) this.onEmpty()
      return
    }
    const previousAnchor = this.firstVisibleId
    const previousSelection = this.selectedValue
    const previousSelectionIndex = previousSelection === undefined ? undefined : this.indexOfValue(previousSelection)
    this.items = items
    // Selection reconciliation (stable ID first, bounded index fallback).
    if (previousSelection !== undefined) {
      const selectedIndex = items.findIndex(item => item.value === previousSelection)
      if (selectedIndex >= 0) {
        this.selectedValue = previousSelection
      } else {
        // Deleted: bounded fallback to the SUCCESSOR of the pre-delete
        // global index; the predecessor when the tail was deleted. The
        // pre-delete index must come from the PREVIOUS rows — the new array
        // no longer contains the value.
        const oldIndex = previousSelectionIndex
        const fallback = oldIndex === undefined ? 0 : Math.min(oldIndex, items.length - 1)
        this.selectedValue = items[Math.max(0, fallback)]?.value
      }
    }
    // Window anchor rebases onto the surviving first visible value.
    const found = previousAnchor === undefined ? -1 : items.findIndex(item => item.value === previousAnchor)
    if (found >= 0) {
      this.start = found
    } else {
      const window = this.currentWindow(items.length)
      this.start = Math.min(Math.max(0, this.start), Math.max(0, items.length - window))
    }
    this.firstVisibleId = items[this.start]?.value
    if (this.selectedValue === undefined) this.selectedValue = items[0]?.value
    if (this.focused && !this.wheelSelectionPending) this.ensureVisible()
    this.requestRender()
  }

  /** The value of the first visible row of the last committed window. */
  get anchoredValue(): string | undefined {
    return this.firstVisibleId
  }

  /** The currently selected row's stable value (ephemeral ACTIVE state). */
  get selected(): string | undefined {
    return this.selectedValue
  }

  /** The visible window size from the last painted frame (1 before the
   *  first paint) — the paging/wheel step and the selection clamp. */
  private currentWindow(itemCount: number): number {
    const painted = this.painted
    const paintedWindow = painted === undefined || painted.itemRows <= 0 ? 1 : painted.itemRows
    return Math.max(1, Math.min(paintedWindow, itemCount))
  }

  /** The index of a stable value in the CURRENT rows (the reconcile path). */
  private indexOfValue(value: string): number | undefined {
    const index = this.items.findIndex(item => item.value === value)
    return index === -1 ? undefined : index
  }


  /** Move the selection by a bounded delta (keyboard Up/Down, wheel). */
  private move(delta: number): void {
    this.wheelSelectionPending = false
    const index = this.selectedValue === undefined ? undefined : this.indexOfValue(this.selectedValue)
    const current = index ?? 0
    const next = Math.min(Math.max(0, current + delta), Math.max(0, this.items.length - 1))
    if (next === current && this.selectedValue !== undefined) {
      // No movement happened; still consume the key.
      this.requestRender()
      return
    }
    this.selectedValue = this.items[next]?.value
    this.ensureVisible()
    this.requestRender()
  }

  /** Page by the ACTUAL visible task-row count (painted window). */
  private page(delta: number): void {
    this.move(delta * this.currentWindow(this.items.length))
  }

  /** Keep the selected row inside the painted window. `windowSize` lets a
   *  freshly recomputed layout apply the same invariant before it is painted. */
  private ensureVisible(windowSize = this.currentWindow(this.items.length)): void {
    const index = this.selectedValue === undefined ? undefined : this.indexOfValue(this.selectedValue)
    if (index === undefined) return
    if (index < this.start) this.start = index
    else if (index >= this.start + windowSize) this.start = index - windowSize + 1
    this.start = Math.max(0, Math.min(this.start, Math.max(0, this.items.length - windowSize)))
    this.firstVisibleId = this.items[this.start]?.value
  }

  /**
   * The ACTIVE keyboard surface. Only the component keymap's task actions
   * are recognized; every other input is CONSUMED as a no-op — it never
   * reaches the background editor and never dispatches a retired modal
   * action. Up at the GLOBAL first row and Esc exit through the host; Down
   * clamps at the tail; Enter commits through the host AFTER the host has
   * left Quick.
   */
  handleInput(data: string): void {
    if (!this.focused) return
    if (componentKeymap.matches(data, 'tasks.cursorUp')) {
      const index = this.selectedValue === undefined ? undefined : this.indexOfValue(this.selectedValue)
      // Up at the GLOBAL first row EXITS (plan §1.3) — never wrap.
      if (index === 0) {
        this.wheelSelectionPending = false
        this.onExit()
        return
      }
      this.move(-1)
      return
    }
    if (componentKeymap.matches(data, 'tasks.cursorDown')) {
      const index = this.selectedValue === undefined ? undefined : this.indexOfValue(this.selectedValue)
      // Down at the tail clamps (never wraps, never exits).
      if (index !== undefined && index >= this.items.length - 1) return
      this.move(1)
      return
    }
    if (componentKeymap.matches(data, 'tasks.pageUp')) { this.page(-1); return }
    if (componentKeymap.matches(data, 'tasks.pageDown')) { this.page(1); return }
    if (componentKeymap.matches(data, 'tasks.open')) {
      const value = this.selectedValue
      if (value === undefined) return
      // The host's onActivate implementation leaves Quick FIRST, then
      // routes the typed selection to the current Task Runtime authority.
      this.onActivate(value)
      return
    }
    if (componentKeymap.matches(data, 'tasks.search.exit')) {
      this.wheelSelectionPending = false
      this.onExit()
      return
    }
    // Every unlisted key is a consumed no-op (plan §1.3): the background
    // editor must never receive it.
  }

  /**
   * Nothing to invalidate: the frame is derived live on every `render()` (the
   * theme, the terminal geometry and the grant all change under it), and the
   * last-painted geometry is a record of what is on screen — not a render
   * cache — so it must survive until the next real paint replaces it.
   */
  invalidate(): void {}

  /**
   * Fullscreen pointer surface (B4-A wheel + B4-B same-row press/release).
   *
   * The wheel keeps its B4-A contract: the whole painted band owns the
   * wheel (identity row included), moves the row window without taking
   * focus. A pending scroll keeps Enter on the last-painted selection until
   * render() paints its matching selection for the new window.
   *
   * A left press on a painted task row records that row's stable VALUE; the
   * synthesized click activates only when the same VALUE still resolves to
   * the same physical row's identity at click time (press A → release B
   * never fires; a row deleted/reordered between press and release never
   * fires on the new occupant). The header/identity row and every blank row
   * are inert. A click activates the typed open directly WITHOUT a focus
   * detour (plan §5: the pointer never enters a hidden intermediate state).
   * A stale frame (a resize that has not been repainted) or a geometry that
   * no longer matches the live terminal is consumed inertly.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const painted = this.painted
    if (painted === undefined) return undefined
    // Outside the painted band the transcript legitimately owns the gesture.
    if (event.y < 0 || event.y >= painted.height) return undefined
    // Stale-frame fences (the B4-A wheel contract, now covering the whole
    // pointer surface): consume without acting when the frame was painted
    // for another geometry.
    if (event.width !== painted.width || event.height !== painted.height) return { handled: true, render: false }
    if (this.geometry.columns() !== painted.terminalColumns || this.geometry.rows() !== painted.terminalRows) {
      return { handled: true, render: false }
    }

    if (event.type === 'wheel') {
      if (event.wheelDelta === undefined || event.wheelDelta === 0) return { handled: true, render: false }
      // A projection that emptied (or that had nothing to show) before the repaint
      // still owns its band: consume without acting, never touch the anchor.
      if (this.items.length === 0) return { handled: true, render: false }
      const step = event.wheelDelta < 0 ? -1 : 1
      const next = Math.min(Math.max(0, this.start + step), Math.max(0, this.items.length - painted.itemRows))
      if (next === this.start) return { handled: true, render: false }
      this.start = next
      this.firstVisibleId = this.items[next]?.value
      if (this.focused) this.wheelSelectionPending = true
      // The painted CONTENT is stale until the repaint this result requests, but the
      // painted GEOMETRY stays the frame the pointer is on: a further wheel arriving
      // before that repaint is still in-band and must not fall through.
      return { handled: true, render: true }
    }

    const hit = painted.hits[event.y]
    if (hit === undefined || hit.kind !== 'item' || hit.value === undefined) {
      // The identity/blank rows are inert chrome — but they still belong to
      // the accessory's band while ACTIVE: consume without acting.
      if (this.focused && (event.type === 'press' || event.type === 'release' || event.type === 'click')) {
        return { handled: true }
      }
      return undefined
    }
    if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click' && event.type !== 'release')) {
      return undefined
    }

    if (event.type === 'press') {
      // The hit map is last-painted geometry: the pressed row must still
      // exist in the CURRENT rows by VALUE (a setItems() between paint and
      // press may have removed it without a repaint — no match => reject).
      const exists = this.items.some(candidate => candidate.value === hit.value)
      if (!exists) {
        this.pressedValue = undefined
        this.pressedFrame = undefined
        return { handled: true }
      }
      this.pressedValue = hit.value
      // The gesture is bound to the frame the user actually SAW: a repaint
      // that changes the frame (a reflow, a resize, a row swap) invalidates
      // the in-flight press even when the stable ID would still match.
      this.pressedFrame = {
        width: painted.width,
        height: painted.height,
        terminalColumns: painted.terminalColumns,
        terminalRows: painted.terminalRows,
        first: this.items[0]?.value,
      }
      return { handled: true, capture: true }
    }

    if (event.type === 'release') {
      // The fork dispatcher's SGR sequence is press → release → SYNTHESIZED
      // click, so the release must NOT clear the pressed identity: the click
      // that follows needs it for the same-row match. The latch is cleared
      // by the click branch (or by deactivate/row-removal paths below).
      if (this.pressedValue === undefined) return { handled: true }
      // A repaint between press and release invalidates the gesture: the
      // click this release may synthesize must not act on the new frame.
      if (this.pressedFrameInvalid()) {
        this.pressedValue = undefined
        this.pressedFrame = undefined
      }
      return { handled: true }
    }

    // click: the pressed identity must match THIS row's identity — press A
    // with a release/click resolving to B never activates (async reorder
    // safety) — AND the gesture must still belong to the CURRENT painted
    // frame (a resize/repaint between press and release kills the stale
    // intent even when origin and row ID survived). Then resolve the
    // CURRENT row by the stable value: the value is the identity, the
    // stale frame's index never is.
    const pressed = this.pressedValue
    const frame = this.pressedFrame
    this.pressedValue = undefined
    this.pressedFrame = undefined
    if (frame === undefined || this.pressedFrameInvalid(frame)) return { handled: true }
    if (pressed !== hit.value) return { handled: true }
    const item = this.items.find(candidate => candidate.value === hit.value)
    if (item === undefined) return { handled: true }
    // Same-row click opens the typed detail directly (no focus detour).
    this.wheelSelectionPending = false
    this.onActivate(item.value)
    return { handled: true }
  }

  /** Whether the pressed frame no longer matches the CURRENT painted frame
   *  (a repaint happened since the press). Called with no argument against
   *  the live latch; with an argument, against a frame snapshot taken at
   *  the click. */
  private pressedFrameInvalid(observed?: {
    readonly width: number
    readonly height: number
    readonly terminalColumns: number
    readonly terminalRows: number
    readonly first: string | undefined
  }): boolean {
    const frame = observed ?? this.pressedFrame
    const painted = this.painted
    if (frame === undefined || painted === undefined) return true
    return frame.width !== painted.width
      || frame.height !== painted.height
      || frame.terminalColumns !== painted.terminalColumns
      || frame.terminalRows !== painted.terminalRows
      || frame.first !== this.items[0]?.value
  }

  render(width: number): string[] {
    // The ONLY visibility gate (B4-B): an unfocused accessory paints zero
    // rows and cuts its stale painted geometry — a stale hit band must not
    // survive a blur.
    if (!this.focused) {
      this.painted = undefined
      if (!this.firstPaintNotified) {
        this.firstPaintNotified = true
        // DEFERRED: render() runs inside the screen's paint pass — a
        // synchronous footer recompose here would mutate components
        // mid-frame. A macrotask lands after this frame AND after the
        // startup commit chain, which is the compose the painted frame
        // should reflect.
        setTimeout(() => this.onFirstPaint(), 0)
      }
      return []
    }
    const columns = Math.max(1, Math.floor(width))
    const terminalRows = this.geometry.rows()
    const chromeRows = this.geometry.chromeRows(columns)
    let layout = planTaskQuickLayout(
      columns,
      terminalRows,
      chromeRows,
      this.items.length,
      this.start,
    )
    if (layout.grant === 0 || layout.count === 0) {
      this.painted = undefined
      this.wheelSelectionPending = false
      // B4-B (review F4): an ACTIVE band that lost its grant (a resize to an
      // extreme frame) retires through the host — the editor regains the
      // keyboard instead of an invisible surface consuming input. A HIDDEN
      // frame was never consuming input, so it stays a data-only update.
      if (this.focused) this.onEmpty()
      return []
    }
    if (this.focused) {
      this.start = layout.start
      if (this.wheelSelectionPending) {
        const selectedIndex = this.selectedValue === undefined ? undefined : this.indexOfValue(this.selectedValue)
        const lastVisibleIndex = layout.start + layout.count - 1
        if (selectedIndex === undefined || selectedIndex < layout.start) this.selectedValue = this.items[layout.start]!.value
        else if (selectedIndex > lastVisibleIndex) this.selectedValue = this.items[lastVisibleIndex]!.value
        this.wheelSelectionPending = false
      }
      this.ensureVisible(layout.count)
      if (this.start !== layout.start) {
        layout = planTaskQuickLayout(columns, terminalRows, chromeRows, this.items.length, this.start)
      }
    }
    const lines: string[] = []
    const hits: TaskQuickHit[] = []
    // Paint order is strictly separator → identity → task rows. The rule is
    // the Quick-owned top boundary (role 15 `border`, the Owner-authorized
    // Footer↔Quick exception — never `primary`/`borderFocus`), it spans the
    // component width exactly, and it is INERT: a pointer event on it is
    // consumed without acting (the hit map records it as identity chrome).
    if (layout.separator) {
      lines.push(color.border('─'.repeat(columns)))
      hits.push({ kind: 'identity' })
    }
    if (layout.header) {
      lines.push(renderHeaderRow(columns, layout.start, layout.count, layout.total))
      hits.push({ kind: 'identity' })
    }
    const position = layout.header ? undefined : `${layout.start + 1}-${layout.start + layout.count}/${layout.total}`
    for (let index = 0; index < layout.count; index += 1) {
      const item = this.items[layout.start + index]
      if (item === undefined) break
      const selected = item.value === this.selectedValue
      lines.push(renderItemRow(item, columns, position, selected))
      hits.push({ kind: 'item', value: item.value })
    }
    while (hits.length < lines.length) hits.push({ kind: 'inert' })
    // The window the frame actually painted is the durable anchor: the next
    // commit rebases onto the row the user really sees.
    this.start = layout.start
    this.firstVisibleId = this.items[layout.start]?.value
    this.painted = {
      width: columns,
      height: lines.length,
      itemRows: layout.count,
      hits,
      terminalColumns: this.geometry.columns(),
      terminalRows,
    }
    return lines
  }
}
