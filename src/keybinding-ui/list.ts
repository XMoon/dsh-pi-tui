/**
 * Keyboard Shortcuts Editor: searchable action-first list, leader setup, and
 * the shared detail/editor child view.
 */

import { decodePrintableKey, matchesKey, truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
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

function printableChunk(data: string): string | undefined {
  const decoded = decodePrintableKey(data)
  if (decoded !== undefined) return decoded
  if (data === '' || data.includes('\x1b')) return undefined
  for (const character of data) {
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return undefined
  }
  return data
}

function statusMarkers(row: KeybindingEditorRow): string {
  const markers: string[] = []
  if (row.customized) markers.push('*')
  if (row.conflict) markers.push('!')
  if (row.fixed) markers.push('fixed')
  if (row.reserved) markers.push('reserved')
  return markers.length === 0 ? '' : ` [${markers.join(', ')}]`
}

function renderActionRow(row: KeybindingEditorRow, selected: boolean, width: number): string {
  const marker = selected ? color.primary('›') : ' '
  const labelText = `${row.label}${statusMarkers(row)}`
  const valueText = row.disabled ? 'Disabled' : formatEditorBindings(row.effective)
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

export class KeybindingEditorPanel implements Component {
  private model: KeybindingEditorModel
  private readonly runMutation: KeybindingMutationRunner
  private readonly onClose: () => void
  private readonly onModelChange: (model: KeybindingEditorModel) => void
  private readonly onDispose: () => void
  private readonly requestRender: () => void
  private readonly maxRows: () => number
  private query = ''
  private selectedId = 'leader'
  private selectedIndex = 0
  private actionEditor: ActionEditorPanel | undefined
  private leaderRecorder: KeyRecorder | undefined
  private leaderEditing = false
  private leaderPending = false
  private mutationGeneration = 0
  private disposed = false
  private message: string | undefined

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
    if (this.actionEditor !== undefined) return this.actionEditor.render(safeWidth)
    if (this.leaderEditing) return this.renderLeaderEditor(safeWidth)

    const lines: string[] = [
      color.textStrong('Keyboard shortcuts'),
      color.textDim(`Search actions, descriptions, IDs, categories, or keys · ${this.model.summary}`),
      `${color.text('Search: ')}${this.query === '' ? color.textDim('type to filter') : color.text(this.query)}`,
      '',
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
    } else {
      for (const entry of entries.slice(start, end)) {
        if (entry.kind === 'header') lines.push(color.textStrong(entry.label))
        else if (entry.kind === 'leader') lines.push(renderLeaderRow(this.model, this.selectedId === 'leader', safeWidth))
        else lines.push(renderActionRow(entry.row, this.selectedId === entry.row.id, safeWidth))
      }
    }
    if (start > 0) lines.push(color.textDim(`↑ ${start} more`))
    if (end < entries.length) lines.push(color.textDim(`↓ ${entries.length - end} more`))
    if (this.message !== undefined) lines.push(color.error(truncateToWidth(this.message, safeWidth)))
    lines.push('', color.textDim('Enter: details · type: search · ↑↓: move · Esc: close'))
    return lines.slice(0, Math.max(1, this.maxRows()))
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
        this.query = ''
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
    if (matchesKey(data, 'backspace')) {
      if (this.query !== '') {
        this.query = this.query.slice(0, -1)
        this.selectedId = 'leader'
        this.selectedIndex = 0
        this.requestRender()
      }
      return
    }
    if (matchesKey(data, 'enter') || data === '\n' || data === '\r') {
      this.openSelected(selectable)
      return
    }
    const chunk = printableChunk(data)
    if (chunk !== undefined) {
      this.query += chunk
      this.selectedId = 'leader'
      this.selectedIndex = 0
      this.message = undefined
      this.requestRender()
    }
  }

  invalidate(): void {
    this.actionEditor?.invalidate?.()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mutationGeneration += 1
    this.actionEditor?.dispose?.()
    this.actionEditor = undefined
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
