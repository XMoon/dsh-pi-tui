/**
 * Detail and mutation view for one keyboard shortcut action.
 */

import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type KeyId } from '@xmoon76/pi-tui'
import { color } from '../theme.ts'
import { formatKeyId, formatLeaderSequence } from '../keybindings/hints.ts'
import type {
  KeybindingEditorBinding,
  KeybindingEditorBindingKind,
  KeybindingEditorModel,
  KeybindingEditorRow,
} from './model.ts'
import { formatEditorBindings } from './model.ts'
import type { KeybindingMutation, KeybindingMutationResult, KeybindingMutationRunner } from './controller.ts'
import { KeyRecorder } from './recorder.ts'

export interface ActionEditorOptions {
  readonly model: KeybindingEditorModel
  readonly action: KeybindingEditorRow
  readonly runMutation: KeybindingMutationRunner
  readonly onModelChange: (model: KeybindingEditorModel) => void
  readonly onBack: () => void
  readonly requestRender?: () => void
  readonly maxRows?: () => number
}

type ActionEditorMode = 'edit' | 'choose-binding'

function commandKey(data: string, key: string): boolean {
  return matchesKey(data, key as KeyId) || (data.length === 1 && data.toLowerCase() === key.toLowerCase())
}

function bindingLabel(binding: KeybindingEditorBinding): string {
  return binding.kind === 'leader' ? formatLeaderSequence(binding.key) : formatKeyId(binding.key)
}

function statusLabel(row: KeybindingEditorRow): string {
  switch (row.status) {
    case 'customized': return 'Customized'
    case 'disabled': return 'Disabled'
    case 'conflict': return 'Conflict'
    case 'fixed': return 'Fixed (not configurable)'
    case 'reserved': return 'Reserved (not implemented)'
    case 'safe-mode': return 'Customized (safe mode is using defaults)'
    case 'unbound': return 'Unbound'
    case 'default': return 'Default'
  }
}

function selectedLine(label: string, selected: boolean, width: number): string {
  const marker = selected ? color.primary('›') : ' '
  const text = `${marker} ${label}`
  return truncateToWidth(text, Math.max(1, width))
}

export class ActionEditorPanel implements Component {
  private model: KeybindingEditorModel
  private row: KeybindingEditorRow
  private readonly runMutation: KeybindingMutationRunner
  private readonly onModelChange: (model: KeybindingEditorModel) => void
  private readonly onBack: () => void
  private readonly requestRender: () => void
  private readonly maxRows: () => number
  private mode: ActionEditorMode = 'edit'
  private selectedIndex = 0
  private recorder: KeyRecorder | undefined
  private pending = false
  private mutationGeneration = 0
  private disposed = false
  private message: string | undefined

  constructor(options: ActionEditorOptions) {
    this.model = options.model
    this.row = options.action
    this.runMutation = options.runMutation
    this.onModelChange = options.onModelChange
    this.onBack = options.onBack
    this.requestRender = options.requestRender ?? (() => {})
    this.maxRows = options.maxRows ?? (() => 18)
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    if (this.recorder !== undefined) return this.recorder.render(safeWidth)
    if (this.mode === 'choose-binding') return this.renderBindingChoice(safeWidth)

    const lines: string[] = [
      color.textStrong(`Keyboard shortcuts › ${this.row.label}`),
      '',
    ]
    lines.push(...wrapTextWithAnsi(this.row.description, safeWidth).map(line => color.text(line)))
    lines.push('')
    lines.push(color.textDim(`Action ID: ${this.row.id}`))
    lines.push(color.textDim(`Scope: ${this.row.scope} · Source: ${this.row.source}`))
    lines.push(color.textDim(`Status: ${statusLabel(this.row)}`))
    if (this.row.reserved) lines.push(color.warning('This action is reserved and has no runtime implementation.'))
    if (this.row.fixed) lines.push(color.textDim('This action is fixed by the application and cannot be edited.'))
    lines.push('')

    const configured = this.row.customized ? this.row.configured : []
    lines.push(color.textStrong(this.row.customized ? 'Configured shortcuts' : 'Shortcuts'))
    if (this.row.customized && configured.length === 0) {
      lines.push(color.textDim(this.row.disabled ? '  Disabled' : '  Unbound'))
    }
    if (!this.row.customized && this.row.defaults.length === 0) {
      lines.push(color.textDim('  Unbound'))
    }
    const canEdit = this.row.configurable && !this.row.reserved
    if (canEdit) {
      for (let index = 0; index < configured.length; index += 1) {
        const binding = configured[index]!
        const suffix = this.row.conflict ? color.warning(' !') : ''
        lines.push(selectedLine(`${bindingLabel(binding)}${suffix}`, this.selectedIndex === index, safeWidth))
      }
      lines.push(selectedLine('+ Add shortcut', this.selectedIndex === configured.length, safeWidth))
    } else if (this.row.defaults.length > 0) {
      for (const binding of this.row.defaults) lines.push(`  ${bindingLabel(binding)}`)
    }

    if (!this.row.customized && this.row.defaults.length > 0) {
      lines.push(color.textDim(`Default: ${formatEditorBindings(this.row.defaults)}`))
    }
    if (this.row.customized && this.row.effective.length > 0 && !sameBindingList(this.row.effective, configured)) {
      lines.push(color.textDim(`Effective now: ${formatEditorBindings(this.row.effective)}`))
    }
    if (this.row.diagnostics.length > 0) {
      for (const diagnostic of this.row.diagnostics.slice(0, 2)) lines.push(color.warning(truncateToWidth(diagnostic, safeWidth)))
    }
    if (this.message !== undefined) lines.push(color.error(truncateToWidth(this.message, safeWidth)))
    if (this.pending) lines.push(color.accent('Saving…'))
    lines.push('')
    lines.push(color.textDim(this.row.fixed
      ? 'Esc: back'
      : 'Enter: edit · a: add · Delete: remove · r: reset · d: disable · Esc: back'))
    return lines.slice(0, Math.max(1, this.maxRows()))
  }

  invalidate(): void {
    this.recorder?.invalidate()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mutationGeneration += 1
    this.recorder = undefined
  }

  handleInput(data: string): void {
    if (this.disposed) return
    if (this.recorder !== undefined) {
      this.recorder.handleInput(data)
      return
    }
    if (this.pending) {
      if (matchesKey(data, 'escape')) {
        this.dispose()
        this.onBack()
      }
      return
    }
    if (this.mode === 'choose-binding') {
      this.handleBindingChoice(data)
      return
    }
    if (matchesKey(data, 'escape')) {
      this.dispose()
      this.onBack()
      return
    }
    if (this.row.fixed || this.row.reserved) return
    const configured = this.row.customized ? this.row.configured : []
    const total = configured.length + 1
    if (matchesKey(data, 'up')) {
      this.selectedIndex = (this.selectedIndex + total - 1) % total
      this.message = undefined
      this.requestRender()
      return
    }
    if (matchesKey(data, 'down')) {
      this.selectedIndex = (this.selectedIndex + 1) % total
      this.message = undefined
      this.requestRender()
      return
    }
    if (commandKey(data, 'a')) {
      this.mode = 'choose-binding'
      this.message = undefined
      this.requestRender()
      return
    }
    if (commandKey(data, 'r')) {
      this.startMutation({ kind: 'reset-action', action: this.row.id })
      return
    }
    if (commandKey(data, 'd')) {
      this.startMutation({ kind: 'disable-action', action: this.row.id })
      return
    }
    if (matchesKey(data, 'delete') || matchesKey(data, 'backspace')) {
      if (this.selectedIndex < configured.length) {
        this.startMutation({ kind: 'remove', action: this.row.id, binding: configured[this.selectedIndex]! })
      }
      return
    }
    if (matchesKey(data, 'enter') || data === '\n' || data === '\r') {
      if (this.selectedIndex >= configured.length) {
        this.mode = 'choose-binding'
        this.message = undefined
        this.requestRender()
      } else {
        this.startRecorder(configured[this.selectedIndex]!.kind, configured[this.selectedIndex])
      }
    }
  }

  private renderBindingChoice(width: number): string[] {
    const lines = [
      color.textStrong(`Add shortcut › ${this.row.label}`),
      '',
      color.text('Choose what to record:'),
      selectedLine('Direct shortcut', this.selectedIndex === 0, width),
      selectedLine('Leader completion', this.selectedIndex === 1, width),
    ]
    if (this.model.leader.key === undefined) {
      lines.push(color.textDim('Leader completion is unavailable until a leader key is configured.'))
    } else {
      lines.push(color.textDim(`Leader prefix: ${formatKeyId(this.model.leader.key)}`))
    }
    if (this.message !== undefined) lines.push(color.error(truncateToWidth(this.message, width)))
    lines.push('', color.textDim('Enter: choose · d/l: choose directly · Esc: back'))
    return lines.slice(0, Math.max(1, this.maxRows()))
  }

  private handleBindingChoice(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.mode = 'edit'
      this.requestRender()
      return
    }
    if (matchesKey(data, 'up') || commandKey(data, 'k')) {
      this.selectedIndex = (this.selectedIndex + 2 - 1) % 2
      this.requestRender()
      return
    }
    if (matchesKey(data, 'down') || commandKey(data, 'j')) {
      this.selectedIndex = (this.selectedIndex + 1) % 2
      this.requestRender()
      return
    }
    if (commandKey(data, 'd')) {
      this.selectedIndex = 0
    } else if (commandKey(data, 'l')) {
      this.selectedIndex = 1
    } else if (!matchesKey(data, 'enter') && data !== '\n' && data !== '\r') {
      return
    }
    if (this.selectedIndex === 1 && this.model.leader.key === undefined) {
      this.message = 'Configure a leader key before adding a leader completion.'
      this.mode = 'edit'
      this.requestRender()
      return
    }
    this.startRecorder(this.selectedIndex === 1 ? 'leader' : 'direct')
  }

  private startRecorder(kind: KeybindingEditorBindingKind, previous?: KeybindingEditorBinding): void {
    this.mode = 'edit'
    this.message = undefined
    this.recorder = new KeyRecorder({
      purpose: kind === 'leader' ? 'leader-completion' : 'direct',
      action: this.row.id,
      label: kind === 'leader' ? 'the leader completion' : this.row.label,
      onCapture: (key) => {
        if (this.disposed) return
        this.recorder = undefined
        const binding: KeybindingEditorBinding = { kind, key }
        const mutation: KeybindingMutation = previous === undefined
          ? { kind: 'add', action: this.row.id, binding }
          : { kind: 'replace', action: this.row.id, previous, binding }
        this.startMutation(mutation)
      },
      onCancel: () => {
        this.recorder = undefined
        if (!this.disposed) this.requestRender()
      },
      requestRender: this.requestRender,
    })
    this.requestRender()
  }

  private startMutation(mutation: KeybindingMutation): void {
    if (this.disposed) return
    const generation = ++this.mutationGeneration
    this.pending = true
    this.message = undefined
    this.requestRender()
    try {
      this.runMutation(
        mutation,
        result => this.applyMutationResult(generation, result),
        error => this.applyMutationError(generation, error),
      )
    } catch (error) {
      this.applyMutationError(generation, error)
    }
  }

  private applyMutationResult(generation: number, result: KeybindingMutationResult): void {
    if (this.disposed || generation !== this.mutationGeneration) return
    this.pending = false
    if (result.kind !== 'applied') {
      this.message = result.message
      this.requestRender()
      return
    }
    const next = result.model.rows.find(row => row.id === this.row.id)
    if (next !== undefined) this.row = next
    this.model = result.model
    this.selectedIndex = Math.min(this.selectedIndex, (this.row.customized ? this.row.configured.length : 0))
    this.message = result.message
    this.onModelChange(result.model)
    this.requestRender()
  }

  private applyMutationError(generation: number, error: unknown): void {
    if (this.disposed || generation !== this.mutationGeneration) return
    this.pending = false
    this.message = error instanceof Error ? error.message : 'Could not save keyboard shortcuts.'
    this.requestRender()
  }
}

function sameBindingList(
  left: readonly KeybindingEditorBinding[],
  right: readonly KeybindingEditorBinding[],
): boolean {
  return left.length === right.length && left.every((binding, index) => {
    const other = right[index]
    return other !== undefined && binding.kind === other.kind && binding.key === other.key
  })
}

export function bindingKey(binding: KeybindingEditorBinding): string {
  return `${binding.kind}:${binding.key}`
}
