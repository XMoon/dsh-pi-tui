/**
 * Keyboard Shortcuts Editor: searchable action-first list, leader setup, and
 * the shared detail/editor child view.
 */

import { matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from '@xmoon76/pi-tui'
import { Input } from '@xmoon76/pi-tui'
import { dispatchMouseEvent } from '@xmoon76/pi-tui'
import type { TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { color } from '../theme.ts'
import { formatKeyId } from '../keybindings/hints.ts'
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
  private readonly maxRows: () => number
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
    this.maxRows = options.maxRows ?? (() => 18)
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    this.lastRenderWidth = safeWidth
    if (this.actionEditor !== undefined) return this.actionEditor.render(safeWidth)
    if (this.leaderEditing) return this.renderLeaderEditor(safeWidth)

    const lines: string[] = [
      color.textStrong('Keyboard shortcuts'),
      ...(this.model.leader.safeMode
        ? [
          color.warning('Safe mode is active. Custom shortcuts are ignored.'),
          color.textDim('Editing is disabled until safe mode is turned off.'),
        ]
        : []),
      color.textDim(`Search actions, descriptions, IDs, categories, or keys · ${this.model.summary}`),
      this.searchRow(safeWidth),
      '',
    ]
    const hits: KeybindingMouseHit[] = [
      { kind: 'inert' },
      ...(this.model.leader.safeMode ? [{ kind: 'inert' }, { kind: 'inert' }] as KeybindingMouseHit[] : []),
      { kind: 'inert' },
      { kind: 'search' },
      { kind: 'inert' },
    ]
    const entries = this.displayEntries()
    const selectable = this.selectableEntries(entries)
    this.ensureSelection(selectable)
    const selectedDisplayIndex = entries.findIndex(entry => this.isSelectedEntry(entry))
    // Reserve space for the bottom hint and both possible scroll markers;
    // the hint must remain visible even when the list is longer than the
    // terminal viewport.
    const listBudget = Math.max(1, this.maxRows() - lines.length - 4)
    const start = Math.max(0, Math.min(
      Math.max(0, selectedDisplayIndex - Math.floor(listBudget / 2)),
      Math.max(0, entries.length - listBudget),
    ))
    const end = Math.min(entries.length, start + listBudget)
    if (entries.length === 0) {
      lines.push(color.textDim('No matching shortcuts.'))
      hits.push({ kind: 'inert' })
    } else {
      for (const entry of entries.slice(start, end)) {
        if (entry.kind === 'header') {
          lines.push(color.textStrong(entry.label))
          hits.push({ kind: 'inert' })
        } else {
          const selectableIndex = selectable.indexOf(entry)
          lines.push(entry.kind === 'leader'
            ? renderLeaderRow(this.model, this.selectedId === 'leader', safeWidth)
            : renderActionRow(entry.row, this.selectedId === entry.row.id, safeWidth))
          hits.push({ kind: 'select', index: selectableIndex, id: this.entryId(entry) })
        }
      }
    }
    if (start > 0) {
      lines.push(color.textDim(`↑ ${start} more`))
      hits.push({ kind: 'inert' })
    }
    if (end < entries.length) {
      lines.push(color.textDim(`↓ ${entries.length - end} more`))
      hits.push({ kind: 'inert' })
    }
    if (this.message !== undefined) {
      lines.push(color.error(truncateToWidth(this.message, safeWidth)))
      hits.push({ kind: 'inert' })
    }
    // The Esc verb follows the two-stage lifecycle: a non-empty query
    // clears first, an empty query closes the panel.
    const escVerb = this.query === '' ? 'close' : 'clear'
    lines.push('', color.textDim(`Enter: details · type: search · ←→: edit · ↑↓: move · Esc: ${escVerb}`))
    hits.push({ kind: 'inert' }, { kind: 'inert' })
    const limit = Math.max(1, this.maxRows())
    this.hitMap = hits.slice(0, limit)
    return lines.slice(0, limit)
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
    const lines = [
      color.textStrong('Keyboard shortcuts › Leader key'),
      '',
      color.text('A leader key prefixes multi-key shortcuts.'),
      color.textDim(`Current: ${current}`),
      ...(safeMode
        ? [color.warning(ignored
          ? 'Safe mode ignores persisted keyboard shortcuts.'
          : 'Safe mode disables leader shortcut editing.')]
        : []),
      '',
      ...(safeMode
        ? [color.textDim('Esc: back')]
        : [color.accent('Enter: record a new leader key'), color.textDim('r: reset leader key · Esc: back')]),
    ]
    if (this.leaderPending) lines.push(color.accent('Saving…'))
    if (this.message !== undefined) lines.push(color.error(truncateToWidth(this.message, width)))
    return lines.slice(0, Math.max(1, this.maxRows()))
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

  constructor(onClose: () => void) {
    this.onClose = onClose
  }

  render(width: number): string[] {
    return [
      truncateToWidth(color.textStrong('Keyboard shortcuts unavailable'), Math.max(1, width)),
      '',
      truncateToWidth(color.error('The settings service could not be read.'), Math.max(1, width)),
      truncateToWidth(color.textDim('Esc: back'), Math.max(1, width)),
    ]
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) this.onClose()
  }

  invalidate(): void {}
}
