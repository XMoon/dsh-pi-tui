/**
 * Task Quick — the passive, non-focusable task accessory below the editor
 * (Phase 3B / B4-A).
 *
 * Anatomy (ONE vertical presentation at every width — a single `render(width)`
 * decides the layout):
 * - Identity row: `Task Quick` (role 1, bold `textStrong`) with the right-aligned
 *   position `showing x-y/N` (role 12, `textMuted`);
 * - Up to three single-line task rows: the projected row label (role 3
 *   `text`, ancestor-context rows role 4 `textDim`), the durable mode suffix
 *   (role 4) and the status group `‣ Running` (role 9, `taskStatusColor` ink +
 *   `taskStatusWord` word);
 * - A granted-one-row frame spends its ONLY row on task content and moves the
 *   compact `x-y/N` to that row's tail — a header never displaces a task row.
 *
 * This component is a display-only projection: it owns the row window (the
 * first visible row ID plus a bounded index fallback), the last PAINTED frame
 * geometry and the wheel hit test. It never reads a Job/Question/Host source,
 * never opens a surface, never acknowledges a failure and never takes keyboard
 * focus — the pointer path below resolves exclusively against the last painted
 * frame and mutates nothing but its own window.
 *
 * Row budget: the accessory is the lowest-priority first-party pinned
 * decoration. Its grant is derived from the LIVE frame — the terminal rows, the
 * pinned chrome the host measures for it, and exactly one visible transcript
 * row — and is additionally capped by its own proportional share of the
 * terminal height and by `TASK_QUICK_MAX_ROWS`. It is never a fixed
 * terminal-size threshold, and it never borrows a row from the editor seat, the
 * footer, the public widget zones or the transcript floor.
 *
 * Visual vocabulary is frozen by `docs/tui-design-language.md` (§3.2 role
 * table, §4.3/§4.4 glyph inventory, §5.2 of the B4-A plan): one `‣` marker and a
 * Title Case status word, no cursor glyph, no brackets, no rules, no second
 * palette token. The legacy modal `TaskBrowserPanel` keeps its own registered
 * per-status glyph debt (§11.4) — this accessory does not copy it.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/task-quick-accessory
 */

import { truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color, taskStatusColor, taskStatusWord } from '../theme/runtime.ts'
import type { TaskPanelItem } from '../../app/surface/task-presentation.ts'

/** The accessory's own row ceiling: identity row + three task rows. This is
 *  the accessory's budget, never a terminal-size threshold. */
export const TASK_QUICK_MAX_ROWS = 4
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
  return { width, grant: 0, header: false, itemRows: 0, start: 0, count: 0, total }
}

/**
 * Derive the accessory's row plan from the LIVE frame:
 *
 * 1. `desired = min(3, N)` — the real projected row count, never a fabricated
 *    one; an empty projection paints nothing at all;
 * 2. `share = floor(terminalRows / 4)` — the accessory's proportional share of
 *    the terminal height, the same shape as the public below-widget zone's cap;
 * 3. `room = terminalRows - chromeRows - 1` — every other owner first, plus one
 *    visible transcript row;
 * 4. `grant = min(4, share, room, desired + 1)` — the identity row is granted
 *    only while a task row still fits under it (a one-row grant is spent on
 *    content), and a row the accessory may not paint is never left blank.
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
  const grant = Math.max(0, Math.min(TASK_QUICK_MAX_ROWS, share, room, desired + 1))
  if (grant === 0) return emptyLayout(width, items)
  const header = grant >= 2
  const capacity = Math.min(desired, header ? grant - 1 : grant)
  const requested = Math.floor(Number.isFinite(startIndex) ? startIndex : 0)
  const start = Math.min(Math.max(0, requested), Math.max(0, items - capacity))
  return {
    width,
    grant,
    header,
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
 * One task row: `<indent>label[ · mode]` + the status group, and — in the
 * granted-one-row frame — the compact position at the tail.
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
function renderItemRow(item: TaskPanelItem, width: number, position?: string): string {
  const statusText = `${STATUS_MARKER} ${sanitizedPhysicalLine(taskStatusWord(item.status))}`
  const status = taskStatusColor(item.status)(statusText)
  const tail = position === undefined ? status : `${status}  ${color.textMuted(position)}`
  const tailWidth = visibleWidth(position === undefined ? statusText : `${statusText}  ${position}`)
  if (tailWidth >= width) return fit(tail, width)
  const room = width - tailWidth - 1
  const indent = '  '.repeat(Math.max(0, Math.floor(item.depth ?? 0)))
  const indentWidth = visibleWidth(indent)
  const suffixText = item.suffix === undefined || item.suffix === '' ? '' : ` · ${item.suffix}`
  const suffixWidth = visibleWidth(suffixText)
  // The durable mode rides as a non-truncatable suffix: it is kept only while
  // the label still owns at least one identifiable cell after it.
  const suffix = suffixWidth > 0 && indentWidth + suffixWidth + 1 <= room ? suffixText : ''
  const labelBudget = Math.max(0, room - indentWidth - visibleWidth(suffix))
  const label = truncateToWidth(sanitizedPhysicalLine(item.label), labelBudget, '…', false)
  const ink = item.ancestorContext === true ? color.textDim : color.text
  const left = `${color.textDim(indent)}${ink(label)}${color.textDim(suffix)}`
  const gap = Math.max(1, width - visibleWidth(left) - tailWidth)
  return `${left}${' '.repeat(gap)}${tail}`
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
  /** The LIVE terminal geometry this frame was painted for. The pi-tui alt
   *  screen builds a pointer event's own box dimensions from its last painted
   *  layout, so after a resize the event still carries the OLD dimensions:
   *  comparing the live geometry at dispatch time is the fence that can
   *  actually detect "this frame was painted for another terminal". */
  readonly terminalColumns: number
  readonly terminalRows: number
}

/**
 * The passive Task Quick accessory.
 *
 * The host owns mounting, the live geometry and the render request; the
 * surface Task Runtime owns the projected rows. The component owns the window
 * anchor (`firstVisibleId` + a bounded index fallback) and the wheel hit test.
 * It holds no timer, no subscription and no catalog: a data commit only
 * re-anchors the window and asks for one repaint.
 */
export class TaskQuickAccessory implements Component {
  private items: TaskPanelItem[] = []
  /** The durable window anchor: the first visible row's stable value. */
  private firstVisibleId: string | undefined
  /** The bounded index fallback used when the anchor row disappeared. */
  private start = 0
  private painted: TaskQuickPainted | undefined
  private readonly geometry: TaskQuickGeometry
  private readonly requestRender: () => void

  constructor(options: { readonly geometry: TaskQuickGeometry; readonly onRequestRender: () => void }) {
    this.geometry = options.geometry
    this.requestRender = options.onRequestRender
  }

  /**
   * Replace the projected rows. The window follows the SAME row identity it
   * showed before: a status update never resets the window, an inserted/removed
   * row rebases onto the surviving first visible value, and a vanished anchor
   * falls back to the bounded previous index — never to a label or a position
   * guess. An empty projection drops the frame and its hit geometry.
   */
  setItems(next: readonly TaskPanelItem[]): void {
    const items = [...next]
    const previous = this.firstVisibleId
    const found = previous === undefined ? -1 : items.findIndex(item => item.value === previous)
    if (items.length === 0) {
      this.items = []
      this.firstVisibleId = undefined
      this.start = 0
      this.painted = undefined
      this.requestRender()
      return
    }
    this.items = items
    if (found >= 0) {
      this.start = found
    } else {
      const window = this.painted === undefined || this.painted.itemRows <= 0 ? 1 : this.painted.itemRows
      this.start = Math.min(Math.max(0, this.start), Math.max(0, items.length - window))
    }
    this.firstVisibleId = items[this.start]?.value
    this.requestRender()
  }

  /** The value of the first visible row of the last committed window. */
  get anchoredValue(): string | undefined {
    return this.firstVisibleId
  }

  /**
   * Nothing to invalidate: the frame is derived live on every `render()` (the
   * theme, the terminal geometry and the grant all change under it), and the
   * last-painted geometry is a record of what is on screen — not a render
   * cache — so it must survive until the next real paint replaces it.
   */
  invalidate(): void {}

  /**
   * Mouse wheel over the painted window: move the row window by one row and
   * repaint. Every other gesture is refused (no press/release/click action and
   * no focus — the pointer may scroll a viewport, never enter the surface).
   *
   * The whole painted band owns the wheel (identity row included): while the
   * pointer is over the accessory the transcript underneath never scrolls, and a
   * wheel at a window boundary is consumed WITHOUT repainting rather than falling
   * through.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'wheel' || event.wheelDelta === undefined || event.wheelDelta === 0) return undefined
    const painted = this.painted
    if (painted === undefined) return undefined
    // Last-painted geometry is authoritative: a resize (or a screen swap) that
    // has not been repainted yet must never resolve against a stale box. The
    // event's own dimensions come from the SAME stale layout cache the frame was
    // painted into, so the LIVE terminal geometry recorded at paint time is the
    // check that can actually fail on a resize.
    if (event.width !== painted.width || event.height !== painted.height) return undefined
    if (this.geometry.columns() !== painted.terminalColumns || this.geometry.rows() !== painted.terminalRows) return undefined
    const localY = event.y
    if (localY < 0 || localY >= painted.height) return undefined
    const step = event.wheelDelta < 0 ? -1 : 1
    const next = Math.min(Math.max(0, this.start + step), Math.max(0, this.items.length - painted.itemRows))
    if (next === this.start) return { handled: true }
    this.start = next
    this.firstVisibleId = this.items[next]?.value
    // The painted frame is stale until the repaint this result requests.
    this.painted = undefined
    return { handled: true, render: true }
  }

  render(width: number): string[] {
    const columns = Math.max(1, Math.floor(width))
    const terminalRows = this.geometry.rows()
    const layout = planTaskQuickLayout(
      columns,
      terminalRows,
      this.geometry.chromeRows(columns),
      this.items.length,
      this.start,
    )
    if (layout.grant === 0 || layout.count === 0) {
      this.painted = undefined
      return []
    }
    const lines: string[] = []
    if (layout.header) lines.push(renderHeaderRow(columns, layout.start, layout.count, layout.total))
    const position = layout.header ? undefined : `${layout.start + 1}-${layout.start + layout.count}/${layout.total}`
    for (let index = 0; index < layout.count; index += 1) {
      const item = this.items[layout.start + index]
      if (item === undefined) break
      lines.push(renderItemRow(item, columns, position))
    }
    // The window the frame actually painted is the durable anchor: the next
    // commit rebases onto the row the user really sees.
    this.start = layout.start
    this.firstVisibleId = this.items[layout.start]?.value
    this.painted = {
      width: columns,
      height: lines.length,
      itemRows: layout.count,
      terminalColumns: this.geometry.columns(),
      terminalRows,
    }
    return lines
  }
}
