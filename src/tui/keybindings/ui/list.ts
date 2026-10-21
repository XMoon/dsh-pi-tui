/**
 * Keyboard Shortcuts Editor: searchable action-first list, leader setup, and
 * the shared detail/editor child view.
 */

import { matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from '@xmoon76/pi-tui'
import { Input } from '@xmoon76/pi-tui'
import { dispatchMouseEvent } from '@xmoon76/pi-tui'
import type { TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { color } from '../../theme/runtime.ts'
import { formatKeyId } from '../hints.ts'
import type { KeyId } from '@xmoon76/pi-tui'
import {
  formatEditorBindings,
  searchKeybindingRows,
  searchMatchesLeader,
  type KeybindingEditorModel,
  type KeybindingEditorRow,
} from './model.ts'
import type { KeybindingMutation, KeybindingMutationResult, KeybindingMutationRunner } from './controller.ts'
import { ActionEditorPanel } from './action-editor.ts'
import { KeyRecorder } from './recorder.ts'

export interface KeybindingEditorPanelOptions {
  readonly model: KeybindingEditorModel
  readonly runMutation: KeybindingMutationRunner
  readonly onClose: () => void
  readonly onModelChange?: (model: KeybindingEditorModel) => void
  readonly onDispose?: () => void
  readonly requestRender?: () => void
  readonly maxRows?: () => number
}

type ListEntry =
  | { readonly kind: 'header'; readonly label: string }
  | { readonly kind: 'leader'; readonly id: 'leader' }
  | { readonly kind: 'action'; readonly row: KeybindingEditorRow }

/** One assembled row of a budgeted panel frame. A `drop` value is the
 * removal priority of an OPTIONAL row (lowest first); a row without one is
 * mandatory and survives every grant. */
interface BudgetRow {
  readonly text: string
  readonly drop?: number
  readonly hit: KeybindingMouseHit
}

/**
 * Fit an assembled frame to the live row grant: optional rows are removed
 * lowest-priority-first, and a final tail slice keeps the LAST rows when
 * even the mandatory set exceeds a degenerate grant (the bottom operation
 * hint is the non-negotiable tail — a head slice would cut it).
 */
function trimToGrant(rows: readonly BudgetRow[], limit: number): BudgetRow[] {
  const kept = [...rows]
  while (kept.length > limit) {
    let index = -1
    let priority = Number.POSITIVE_INFINITY
    for (let i = 0; i < kept.length; i += 1) {
      const drop = kept[i]!.drop
      if (drop !== undefined && drop < priority) {
        priority = drop
        index = i
      }
    }
    if (index === -1) break
    kept.splice(index, 1)
  }
  return kept.length > limit ? kept.slice(kept.length - limit) : kept
}

function commandKey(data: string, key: string): boolean {
  return matchesKey(data, key as KeyId) || (data.length === 1 && data.toLowerCase() === key.toLowerCase())
}

function statusMarkers(row: KeybindingEditorRow): string {
  const markers: string[] = []
  if (row.customized) markers.push('*')
  if (row.status === 'safe-mode') markers.push('safe mode')
  if (row.status === 'unbound') markers.push('unbound')
  if (row.conflict) markers.push('!')
  if (row.fixed) markers.push('fixed')
  if (row.reserved) markers.push('reserved')
  return markers.length === 0 ? '' : ` [${markers.join(', ')}]`
}

function rowBindingText(row: KeybindingEditorRow): string {
  const ordinary = row.effective.filter(binding => !row.conditional.some(candidate =>
    candidate.kind === binding.kind && candidate.key === binding.key))
  const parts: string[] = []
  if (ordinary.length > 0) parts.push(formatEditorBindings(ordinary))
  if (row.conditional.length > 0) {
    parts.push(row.conditional
      .map(binding => `${formatKeyId(binding.key)} (conditional)`)
      .join(' / '))
  }
  return parts.join(' / ') || 'Unbound'
}

function renderActionRow(row: KeybindingEditorRow, selected: boolean, width: number): string {
  const marker = selected ? color.primary('›') : ' '
  const labelText = `${row.label}${statusMarkers(row)}`
  const valueText = row.disabled ? 'Disabled' : rowBindingText(row)
  const available = Math.max(1, width - 2)
  const leftWidth = Math.min(available, Math.max(18, Math.floor(available * 0.57)))
  const left = truncateToWidth(labelText, leftWidth)
  const right = truncateToWidth(valueText, Math.max(1, available - visibleWidth(left) - 2))
  const gap = ' '.repeat(Math.max(2, available - visibleWidth(left) - visibleWidth(right)))
  const styledLeft = selected ? color.textStrong(left) : color.text(left)
  const styledRight = row.conflict ? color.warning(right) : color.textDim(right)
  return truncateToWidth(`${marker} ${styledLeft}${gap}${styledRight}`, Math.max(1, width))
}

function renderLeaderRow(model: KeybindingEditorModel, selected: boolean, width: number): string {
  const marker = selected ? color.primary('›') : ' '
  const ignored = model.leader.safeMode && model.leader.customized
  const value = ignored
    ? 'Ignored by safe mode'
    : model.leader.key === undefined
      ? 'Not configured'
      : formatKeyId(model.leader.key)
  const suffix = model.leader.customized ? ' *' : ''
  const text = `${marker} ${selected ? color.textStrong('Leader key') : color.text('Leader key')}${suffix}  ${color.textDim(value)}`
  return truncateToWidth(text, Math.max(1, width))
}

/** One physical row of the last painted panel frame (mouse hit-testing).
 * The map is built from the EXACT final rows render() returns, so a
 * click can only act on last-painted geometry. (Mouse parity.) */
type KeybindingMouseHit =
  | { kind: 'search' }
  | { kind: 'select'; index: number; id: string }
  | { kind: 'inert' }

export class KeybindingEditorPanel implements Component, Focusable {
  /**
   * Focusable forwarding (the FocusForwardingFrame contract): the panel
   * owns a real Input, so the focused flag must reach it — otherwise the
   * Input never emits CURSOR_MARKER and the IME candidate window /
   * hardware cursor stays at the previous position. Mirrors
   * HistoryPanel / TaskBrowserPanel / SearchablePicker.
   */
  get focused(): boolean {
    return this.searchInput.focused
  }

  set focused(value: boolean) {
    this.searchInput.focused = value
  }
  private model: KeybindingEditorModel
  private readonly runMutation: KeybindingMutationRunner
  private readonly onClose: () => void
  private readonly onModelChange: (model: KeybindingEditorModel) => void
  private readonly onDispose: () => void
  private readonly requestRender: () => void
  /** The standalone cap (`/keybindings` mounted on its own overlay). */
  private readonly standaloneRows: () => number
  /** The EFFECTIVE content-row grant: the standalone cap lowered by the
   * parent SettingsList's live grant when this panel is a `/settings`
   * submenu, so a nested panel never claims the whole terminal height. */
  private readonly maxRows: () => number
  /** Live parent content-row grant (the `SettingsList` `RowBudgetAware`
   * slot); undefined while the panel is standalone. */
  private parentContentRows: number | undefined
  /** The shared Input is the ONLY query source of truth (left/right/Home/
   * End/Ctrl+A/E/B/F/delete/kill/undo all work here — the old hand-rolled
   * `query += chunk` string editing could only append and Backspace). */
  // Empty prompt: the 'Search: ' label is rendered OUTSIDE the Input,
  // so a hidden '> ' would offset mouse click positioning by its width.
  private readonly searchInput = new Input({ prompt: '' })
  /** Read-only query view (the render + filtering read this; the Input
   * alone mutates it). */
  private get query(): string {
    return this.searchInput.getValue()
  }
  private selectedId = 'leader'
  private selectedIndex = 0
  private actionEditor: ActionEditorPanel | undefined
  private leaderRecorder: KeyRecorder | undefined
  private leaderEditing = false
  private leaderPending = false
  private mutationGeneration = 0
  private disposed = false
  private message: string | undefined
  /** Physical row → hit entry from the LAST render (mouse parity). */
  private hitMap: KeybindingMouseHit[] = []
  /** The pressed action/leader ID (mouse parity): a synthesized click may
   * only activate the exact identity that was pressed — a query/model
   * change between press and release must never activate a different
   * action. */
  private mousePressedId: string | undefined
  /** The width the hit map was painted at; a stale-width event is rejected. */
  private lastRenderWidth = 0

  constructor(options: KeybindingEditorPanelOptions) {
    this.model = options.model
    this.runMutation = options.runMutation
    this.onClose = options.onClose
    this.onModelChange = options.onModelChange ?? (() => {})
    this.onDispose = options.onDispose ?? (() => {})
    this.requestRender = options.requestRender ?? (() => {})
    this.standaloneRows = options.maxRows ?? (() => 18)
    this.maxRows = () => Math.max(1, Math.min(
      this.standaloneRows(),
      this.parentContentRows ?? Number.POSITIVE_INFINITY,
    ))
  }

  /** RowBudgetAware seam (the fork's `SettingsList` submenu slot): the
   * parent forwards its live content-row grant when the submenu opens and
   * on every later change. ONLY the row grant is updated — the query,
   * selection, child panels and mutation generation are untouched, so a
   * nested resize never resets the editor state. */
  setMaxRows(rows: number): void {
    this.parentContentRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : undefined
    this.requestRender()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    this.lastRenderWidth = safeWidth
    if (this.actionEditor !== undefined) return this.actionEditor.render(safeWidth)
    if (this.leaderEditing) return this.renderLeaderEditor(safeWidth)

    const limit = Math.max(1, this.maxRows())
    const title = color.textStrong('Keyboard shortcuts')
    const searchRow = this.searchRow(safeWidth)
    // The Esc verb follows the two-stage lifecycle: a non-empty query
    // clears first, an empty query closes the panel.
    const escVerb = this.query === '' ? 'close' : 'clear'
    const hint = color.textDim(`Enter: details · type: search · ←→: edit · ↑↓: move · Esc: ${escVerb}`)
    // Degenerate grants: the bottom operation hint is the non-negotiable
    // tail. Below four rows the title and the search row take what fits, in
    // an order that keeps the panel identifiable and the query editable.
    if (limit === 1) {
      this.hitMap = [{ kind: 'inert' }]
      return [hint]
    }
    if (limit === 2) {
      this.hitMap = [{ kind: 'inert' }, { kind: 'inert' }]
      return [title, hint]
    }
    if (limit === 3) {
      this.hitMap = [{ kind: 'inert' }, { kind: 'search' }, { kind: 'inert' }]
      return [title, searchRow, hint]
    }

    const entries = this.displayEntries()
    const selectable = this.selectableEntries(entries)
    this.ensureSelection(selectable)
    const selectedDisplayIndex = entries.findIndex(entry => this.isSelectedEntry(entry))
    // Assemble the ideal frame in its normal order and drop what does not
    // fit. `drop` is the removal priority (lowest first): the blank
    // separators and scroll markers yield first, then the optional
    // description/safe-mode chrome, and the operation hint is mandatory, so
    // it can never be head-cut off the bottom.
    const rows: BudgetRow[] = [
      { text: title, hit: { kind: 'inert' } },
    ]
    if (this.model.leader.safeMode) {
      rows.push(
        { text: color.warning('Safe mode is active. Custom shortcuts are ignored.'), hit: { kind: 'inert' }, drop: 32 },
        { text: color.textDim('Editing is disabled until safe mode is turned off.'), hit: { kind: 'inert' }, drop: 31 },
      )
    }
    rows.push({
      text: color.textDim(`Search actions, descriptions, IDs, categories, or keys · ${this.model.summary}`),
      hit: { kind: 'inert' },
      drop: 30,
    })
    rows.push({ text: searchRow, hit: { kind: 'search' } })
    // Rows reserved below the item window: the blank separator after the
    // search row, both scroll markers, and the trailing blank + hint. The
    // status line takes one more when present. Reserving the same optional
    // rows as before keeps the item window (and the whole ample-grant
    // frame) byte-identical to the previous assembly; the trim below only
    // removes what genuinely cannot fit.
    const reservedTail = 5 + (this.message !== undefined ? 1 : 0)
    const listBudget = Math.max(1, Math.min(
      Math.max(1, entries.length),
      limit - rows.length - reservedTail,
    ))
    const start = Math.max(0, Math.min(
      Math.max(0, selectedDisplayIndex - Math.floor(listBudget / 2)),
      Math.max(0, entries.length - listBudget),
    ))
    const end = Math.min(entries.length, start + listBudget)
    rows.push({ text: '', hit: { kind: 'inert' }, drop: 10 })
    if (entries.length === 0) {
      rows.push({ text: color.textDim('No matching shortcuts.'), hit: { kind: 'inert' } })
    } else {
      for (const entry of entries.slice(start, end)) {
        if (entry.kind === 'header') {
          rows.push({ text: color.textStrong(entry.label), hit: { kind: 'inert' } })
        } else {
          const selectableIndex = selectable.indexOf(entry)
          rows.push({
            text: entry.kind === 'leader'
              ? renderLeaderRow(this.model, this.selectedId === 'leader', safeWidth)
              : renderActionRow(entry.row, this.selectedId === entry.row.id, safeWidth),
            hit: { kind: 'select', index: selectableIndex, id: this.entryId(entry) },
          })
        }
      }
      if (start > 0) rows.push({ text: color.textDim(`↑ ${start} more`), hit: { kind: 'inert' }, drop: 20 })
      if (end < entries.length) rows.push({ text: color.textDim(`↓ ${entries.length - end} more`), hit: { kind: 'inert' }, drop: 21 })
    }
    if (this.message !== undefined) {
      rows.push({ text: color.error(truncateToWidth(this.message, safeWidth)), hit: { kind: 'inert' }, drop: 40 })
    }
    rows.push({ text: '', hit: { kind: 'inert' }, drop: 5 })
    rows.push({ text: hint, hit: { kind: 'inert' } })
    const kept = trimToGrant(rows, limit)
    // The hit map is built from the EXACT rows this render returns, so a
    // click can only act on last-painted geometry.
    this.hitMap = kept.map(row => row.hit)
    return kept.map(row => row.text)
  }

  /** The search row: the `Search: ` label combined with the shared
   * Input's real render (the user sees the actual cursor position while
   * editing the query). An empty query keeps the dim placeholder. The
   * combined row is truncated to the panel width (ANSI-safe — the Input's
   * fake cursor rides inside, and truncateToWidth preserves escape
   * sequences), so a very narrow terminal can never overflow. */
  private searchRow(width: number): string {
    const label = 'Search: '
    const labelWidth = visibleWidth(label)
    // The Input has an EMPTY prompt: its render is the value (and the
    // fake cursor) directly, so rendered geometry, mouse geometry and
    // the Input's own geometry all agree.
    const inputLines = this.searchInput.render(Math.max(1, width - labelWidth))
    const inputLine = inputLines[0] ?? ''
    const content = this.query === ''
      ? `${color.text(label)}${color.textDim('type to filter')}`
      : `${color.text(label)}${color.text(inputLine)}`
    return truncateToWidth(content, Math.max(1, width), '…')
  }

  handleInput(data: string): void {
    if (this.disposed) return
    if (this.actionEditor !== undefined) {
      this.actionEditor.handleInput(data)
      return
    }
    if (this.leaderEditing) {
      this.handleLeaderInput(data)
      return
    }
    if (matchesKey(data, 'escape')) {
      if (this.query !== '') {
        this.searchInput.setValue('')
        this.selectedId = 'leader'
        this.selectedIndex = 0
        this.message = undefined
        this.requestRender()
      } else {
        this.dispose()
        this.onClose()
      }
      return
    }
    const selectable = this.selectableEntries(this.displayEntries())
    this.ensureSelection(selectable)
    // The parent owns ONLY the list/control keys; EVERY other key —
    // printable text, ←→/Home/End cursor movement, Ctrl+A/E/B/F/W/U/K/Y,
    // Backspace/Delete, word moves, undo, paste — goes to the shared
    // Input, the single query source of truth.
    if (matchesKey(data, 'up')) {
      this.moveSelection(-1, selectable)
      return
    }
    if (matchesKey(data, 'down')) {
      this.moveSelection(1, selectable)
      return
    }
    if (matchesKey(data, 'pageUp')) {
      this.moveSelection(-Math.max(1, this.maxRows() - 6), selectable)
      return
    }
    if (matchesKey(data, 'pageDown')) {
      this.moveSelection(Math.max(1, this.maxRows() - 6), selectable)
      return
    }
    if (matchesKey(data, 'enter') || data === '\n' || data === '\r') {
      this.openSelected(selectable)
      return
    }
    const before = this.searchInput.getValue()
    this.searchInput.handleInput(data)
    if (this.searchInput.getValue() !== before) {
      // The query changed: filter again and reset the selection to the top.
      this.selectedId = 'leader'
      this.selectedIndex = 0
      this.message = undefined
      this.requestRender()
    }
  }

  /**
   * Mouse parity: the hit map from the LAST render decides what a pointer
   * event may act on — the search Input row, a selectable row (leader or
   * action; press selects, click opens like Enter), or inert chrome
   * (headers, scroll markers, message, hint). Wheel moves the selection.
   * While the leader recorder is capturing, mouse events are NOT
   * interpreted as keybindings: the TUI mouse path consumes SGR bytes
   * before they can reach the recorder, and this handler stays inert.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // A click ends any gesture: release the pressed identity up front —
    // a click on inert/width-mismatched geometry must not leave a stale
    // latch that a later click could match. The local copy still guards
    // the valid-row comparison below.
    const pressedId = this.mousePressedId
    if (event.type === 'click') this.mousePressedId = undefined
    // The hit map is only valid for the last painted width: a resize
    // that has not been repainted must not dispatch against stale
    // geometry (last-painted geometry is authoritative).
    if (event.width !== this.lastRenderWidth) return undefined
    if (this.actionEditor !== undefined) return this.actionEditor.handleMouse?.(event)
    if (this.leaderEditing) return undefined
    const hit = this.hitMap[event.y]
    if (!hit) return undefined

    if (hit.kind === 'search') {
      if (event.type !== 'press') return undefined
      // The search Input starts after the "Search: " label; translate to
      // its local coordinates.
      const result = dispatchMouseEvent(this.searchInput, { ...event, x: event.x - 8, y: 0 })
      return result ? { ...result, focus: true } : undefined
    }

    if (hit.kind === 'select') {
      if (event.type === 'wheel' && event.wheelDelta) {
        const selectable = this.selectableEntries(this.displayEntries())
        if (selectable.length === 0) return undefined
        const delta = event.wheelDelta < 0 ? -1 : 1
        this.moveSelection(delta, selectable)
        return { handled: true, render: true }
      }
      if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) return undefined
      if (event.type === 'press') {
        // Every press starts a fresh gesture: clear any latched pressed
        // identity first (a rejected stale press must not leave an old
        // ID that a later synthetic click could match).
        this.mousePressedId = undefined
        // The hit map is last-painted geometry: resolve the CURRENT
        // selectable index by the stable action/leader ID (a query or
        // model change between paint and press may have reordered or
        // shrunk the list WITHOUT a repaint, so the stale ordinal can
        // point at a different action — or past the end). No match =>
        // reject the press.
        const selectable = this.selectableEntries(this.displayEntries())
        const currentIndex = selectable.findIndex(entry => this.entryId(entry) === hit.id)
        if (currentIndex === -1) return undefined
        this.mousePressedId = hit.id
        if (this.selectedIndex !== currentIndex) {
          this.selectedIndex = currentIndex
          this.selectedId = hit.id
          this.message = undefined
        }
        return { handled: true, focus: true }
      }
      // click: the same action as Enter, but only for the exact pressed
      // identity — a query/model change between press and release must
      // not activate a different action. The identity was released at
      // handler entry; the local copy guards the comparison.
      if (pressedId !== hit.id) return undefined
      const selectable = this.selectableEntries(this.displayEntries())
      const currentIndex = selectable.findIndex(entry => this.entryId(entry) === hit.id)
      if (currentIndex === -1) return undefined
      this.selectedIndex = currentIndex
      this.selectedId = hit.id
      this.openSelected(selectable)
      return { handled: true }
    }

    return undefined
  }

  invalidate(): void {
    this.actionEditor?.invalidate?.()
    this.searchInput.invalidate()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mutationGeneration += 1
    this.actionEditor?.dispose?.()
    this.actionEditor = undefined
    this.leaderRecorder?.dispose()
    this.leaderRecorder = undefined
    this.onDispose()
  }

  private displayEntries(): readonly ListEntry[] {
    const matches = searchKeybindingRows(this.model.rows, this.query)
    const matchedRows = new Set(matches.map(match => match.row.id))
    const entries: ListEntry[] = []
    if (searchMatchesLeader(this.model.leader, this.query)) entries.push({ kind: 'leader', id: 'leader' })
    for (const section of this.model.sections) {
      const rows = section.rows.filter(row => matchedRows.has(row.id))
      if (rows.length === 0) continue
      entries.push({ kind: 'header', label: section.category })
      for (const row of rows) entries.push({ kind: 'action', row })
    }
    return entries
  }

  private selectableEntries(entries: readonly ListEntry[]): readonly ListEntry[] {
    return entries.filter(entry => entry.kind !== 'header')
  }

  private isSelectedEntry(entry: ListEntry): boolean {
    return entry.kind === 'leader' ? this.selectedId === 'leader' : entry.kind === 'action' && this.selectedId === entry.row.id
  }

  private ensureSelection(selectable: readonly ListEntry[]): void {
    if (selectable.length === 0) {
      this.selectedIndex = 0
      return
    }
    const existing = selectable.findIndex(entry => this.isSelectedEntry(entry))
    if (existing >= 0) {
      this.selectedIndex = existing
      return
    }
    this.selectedIndex = Math.min(this.selectedIndex, selectable.length - 1)
    this.selectedId = this.entryId(selectable[this.selectedIndex]!)
  }

  private entryId(entry: ListEntry): string {
    return entry.kind === 'leader' ? 'leader' : entry.kind === 'action' ? entry.row.id : ''
  }

  private moveSelection(delta: number, selectable: readonly ListEntry[]): void {
    if (selectable.length === 0) return
    this.ensureSelection(selectable)
    const next = (this.selectedIndex + delta) % selectable.length
    this.selectedIndex = next < 0 ? next + selectable.length : next
    this.selectedId = this.entryId(selectable[this.selectedIndex]!)
    this.message = undefined
    this.requestRender()
  }

  private openSelected(selectable: readonly ListEntry[]): void {
    this.ensureSelection(selectable)
    const selected = selectable[this.selectedIndex]
    if (selected === undefined) return
    if (selected.kind === 'leader') {
      this.leaderEditing = true
      this.message = undefined
      this.requestRender()
      return
    }
    if (selected.kind !== 'action') return
    this.actionEditor = new ActionEditorPanel({
      model: this.model,
      action: selected.row,
      runMutation: this.runMutation,
      onModelChange: model => this.applyModel(model),
      onBack: () => {
        this.actionEditor?.dispose()
        this.actionEditor = undefined
        this.requestRender()
      },
      requestRender: this.requestRender,
      maxRows: this.maxRows,
    })
    this.requestRender()
  }

  private renderLeaderEditor(width: number): string[] {
    if (this.leaderRecorder !== undefined) return this.leaderRecorder.render(width)
    const safeMode = this.model.leader.safeMode
    const ignored = safeMode && this.model.leader.customized
    const current = ignored
      ? 'Ignored by safe mode'
      : this.model.leader.key === undefined
        ? 'Not configured'
        : formatKeyId(this.model.leader.key)
    // Tail priority: the operation row (which carries `Esc: back`) is
    // mandatory, the in-flight/error status is dropped last among the
    // optional rows, and the blank spacers yield before the description —
    // so a short grant never replaces the way back with empty lines.
    const rows: BudgetRow[] = [
      { text: color.textStrong('Keyboard shortcuts › Leader key'), hit: { kind: 'inert' }, drop: 15 },
      { text: '', hit: { kind: 'inert' }, drop: 10 },
      { text: color.text('A leader key prefixes multi-key shortcuts.'), hit: { kind: 'inert' }, drop: 20 },
      { text: color.textDim(`Current: ${current}`), hit: { kind: 'inert' }, drop: 25 },
      ...(safeMode
        ? [{
          text: color.warning(ignored
            ? 'Safe mode ignores persisted keyboard shortcuts.'
            : 'Safe mode disables leader shortcut editing.'),
          hit: { kind: 'inert' } as KeybindingMouseHit,
          drop: 30,
        }]
        : []),
      { text: '', hit: { kind: 'inert' }, drop: 5 },
      ...(safeMode
        ? [{ text: color.textDim('Esc: back'), hit: { kind: 'inert' } as KeybindingMouseHit }]
        : [
          { text: color.accent('Enter: record a new leader key'), hit: { kind: 'inert' } as KeybindingMouseHit },
          { text: color.textDim('r: reset leader key · Esc: back'), hit: { kind: 'inert' } as KeybindingMouseHit },
        ]),
      ...(this.leaderPending
        ? [{ text: color.accent('Saving…'), hit: { kind: 'inert' } as KeybindingMouseHit, drop: 40 }]
        : []),
      ...(this.message !== undefined
        ? [{ text: color.error(truncateToWidth(this.message, width)), hit: { kind: 'inert' } as KeybindingMouseHit, drop: 45 }]
        : []),
    ]
    return trimToGrant(rows, Math.max(1, this.maxRows())).map(row => row.text)
  }

  private handleLeaderInput(data: string): void {
    if (this.leaderRecorder !== undefined) {
      this.leaderRecorder.handleInput(data)
      return
    }
    if (this.leaderPending) return
    if (matchesKey(data, 'escape')) {
      this.leaderEditing = false
      this.message = undefined
      this.requestRender()
      return
    }
    if (this.model.leader.safeMode) {
      this.message = 'Safe mode ignores persisted keyboard shortcuts.'
      this.requestRender()
      return
    }
    if (commandKey(data, 'r')) {
      this.startLeaderMutation({ kind: 'set-leader', key: undefined })
      return
    }
    if (matchesKey(data, 'enter') || data === '\n' || data === '\r') {
      this.leaderRecorder = new KeyRecorder({
        purpose: 'leader-key',
        label: 'the global leader key',
        onCapture: key => {
          this.leaderRecorder = undefined
          if (!this.disposed) this.startLeaderMutation({ kind: 'set-leader', key })
        },
        onCancel: () => {
          this.leaderRecorder = undefined
          if (!this.disposed) this.requestRender()
        },
        requestRender: this.requestRender,
      })
      this.message = undefined
      this.requestRender()
    }
  }

  private startLeaderMutation(mutation: KeybindingMutation): void {
    if (this.disposed) return
    if (this.model.leader.safeMode) {
      this.message = 'Safe mode ignores persisted keyboard shortcuts.'
      this.requestRender()
      return
    }
    const generation = ++this.mutationGeneration
    this.leaderPending = true
    this.message = undefined
    this.requestRender()
    try {
      this.runMutation(
        mutation,
        result => this.applyLeaderResult(generation, result),
        error => this.applyLeaderError(generation, error),
      )
    } catch (error) {
      this.applyLeaderError(generation, error)
    }
  }

  private applyLeaderResult(generation: number, result: KeybindingMutationResult): void {
    if (this.disposed || generation !== this.mutationGeneration) return
    this.leaderPending = false
    if (result.kind !== 'applied') {
      this.message = result.message
      this.requestRender()
      return
    }
    this.applyModel(result.model)
    this.message = result.message
    this.requestRender()
  }

  private applyLeaderError(generation: number, error: unknown): void {
    if (this.disposed || generation !== this.mutationGeneration) return
    this.leaderPending = false
    this.message = error instanceof Error ? error.message : 'Could not save keyboard shortcuts.'
    this.requestRender()
  }

  private applyModel(model: KeybindingEditorModel): void {
    this.model = model
    this.onModelChange(model)
    this.requestRender()
  }
}

export function keybindingEditorLeaderKey(model: KeybindingEditorModel): KeyId | undefined {
  return model.leader.key
}

export function keybindingEditorSummary(model: KeybindingEditorModel): string {
  return model.summary
}

export function keybindingEditorMutationResultMessage(result: KeybindingMutationResult): string {
  return result.kind === 'applied' ? result.message : result.message
}

/** A safe submenu fallback when the ConfigPort cannot be read. */
export class KeybindingEditorUnavailablePanel implements Component {
  private readonly onClose: () => void
  /** Live parent content-row grant (the `SettingsList` `RowBudgetAware`
   * slot); undefined while the panel is not nested. */
  private parentContentRows: number | undefined

  constructor(onClose: () => void) {
    this.onClose = onClose
  }

  /** RowBudgetAware seam (mirrors KeybindingEditorPanel): the fixed four-row
   * fallback is unchanged on an ample grant and keeps `Esc: back` on a
   * short one. */
  setMaxRows(rows: number): void {
    this.parentContentRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : undefined
  }

  render(width: number): string[] {
    const rows: BudgetRow[] = [
      { text: truncateToWidth(color.textStrong('Keyboard shortcuts unavailable'), Math.max(1, width)), hit: { kind: 'inert' }, drop: 15 },
      { text: '', hit: { kind: 'inert' }, drop: 5 },
      { text: truncateToWidth(color.error('The settings service could not be read.'), Math.max(1, width)), hit: { kind: 'inert' }, drop: 10 },
      { text: truncateToWidth(color.textDim('Esc: back'), Math.max(1, width)), hit: { kind: 'inert' } },
    ]
    if (this.parentContentRows === undefined) return rows.map(row => row.text)
    return trimToGrant(rows, this.parentContentRows).map(row => row.text)
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) this.onClose()
  }

  invalidate(): void {}
}
