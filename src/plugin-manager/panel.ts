/**
 * Plugin Manager panel (P1-A/A2/A3): rendering and input only. It draws the
 * rows the controller exposes, converts semantic keys into controller
 * actions, and owns the install dialog's text widgets (spec + custom
 * registry). It never reads a Host service, never mutates inventory and
 * never decides success.
 *
 * @module @xmoon76/dsh-pi-tui/plugin-manager/panel
 */

import { Input, matchesKey, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component, Focusable } from '@xmoon76/pi-tui'
import { color } from '../theme.ts'
import type { PluginManagerController, PluginInstallView } from './controller.ts'
import type { PluginManagerRow } from './model.ts'

function tone(text: string, rowTone: PluginManagerRow['tone']): string {
  switch (rowTone) {
    case 'dim': return color.textDim(text)
    case 'success': return color.success(text)
    case 'warning': return color.warning(text)
    case 'error': return color.error(text)
    default: return text
  }
}

function badge(text: string, rowTone: PluginManagerRow['tone']): string {
  return tone(`[${text}]`, rowTone)
}

/** The Plugin Manager overlay component. */
export class PluginManagerPanel implements Component, Focusable {
  private readonly controller: PluginManagerController
  private readonly requestRender: () => void
  private maxRows = Number.POSITIVE_INFINITY
  private _focused = false
  private disposed = false
  private readonly specInput = new Input()
  private readonly registryInput = new Input()
  private installFocus: 'spec' | 'registry' = 'spec'
  private registryIndex = 0
  private customRegistry = false
  /** Fired once when the owning surface disposes this panel (any hide path). */
  private readonly onDispose: (() => void) | undefined
  private disposeNotified = false

  constructor(
    controller: PluginManagerController,
    requestRender: () => void,
    options: { readonly onDispose?: () => void } = {},
  ) {
    this.controller = controller
    this.requestRender = requestRender
    this.onDispose = options.onDispose
    this.registryInput.setValue('')
  }

  /** The frame's row budget (frame height minus its two border rows). */
  setMaxRows(rows: number): void {
    this.maxRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : Number.POSITIVE_INFINITY
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.syncInputFocus()
  }

  invalidate(): void {
    this.specInput.invalidate()
    this.registryInput.invalidate()
  }

  dispose(): void {
    this.disposed = true
    this.specInput.focused = false
    this.registryInput.focused = false
    // A surface-level teardown (e.g. the Settings parent overlay being hidden)
    // disposes the panel WITHOUT invoking its close path. Notify exactly once
    // so the runner can drop its active-host reference.
    if (this.disposeNotified) return
    this.disposeNotified = true
    this.onDispose?.()
  }

  handleInput(data: string): void {
    if (this.disposed) return
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.controller.back()
      return
    }
    const install = this.controller.installView()
    if (install !== undefined) {
      this.handleInstallInput(data, install)
      return
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.controller.move(-1)
      this.requestRender()
      return
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.controller.move(1)
      this.requestRender()
      return
    }
    if (matchesKey(data, 'enter')) {
      this.controller.activate()
      this.requestRender()
      return
    }
    // Component-local printable keys (never global bindings): refresh / install.
    if (data === 'r' || data === 'R') {
      this.controller.refresh()
      return
    }
    if (data === 'i' || data === 'I') {
      this.controller.openInstall()
      return
    }
  }

  private handleInstallInput(data: string, install: PluginInstallView): void {
    if (install.phase === 'editing') {
      if (matchesKey(data, 'tab')) {
        this.installFocus = this.installFocus === 'spec' ? 'registry' : 'spec'
        this.syncInputFocus()
        this.requestRender()
        return
      }
      if (this.installFocus === 'spec') {
        if (matchesKey(data, 'enter')) {
          this.submitInspect()
          return
        }
        this.specInput.handleInput(data)
        this.requestRender()
        return
      }
      if (this.customRegistry) {
        if (matchesKey(data, 'enter')) {
          this.submitInspect()
          return
        }
        this.registryInput.handleInput(data)
        this.requestRender()
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
        return
      }
      return
    }
    if (install.phase === 'confirm') {
      if (matchesKey(data, 'enter') && install.inspection?.status === 'accepted') {
        this.controller.confirmInstall()
        this.requestRender()
      }
      return
    }
    if (data === 'c' || data === 'C') {
      this.controller.cancelInstall()
      this.requestRender()
    }
  }

  private submitInspect(): void {
    this.controller.inspect(this.specInput.getValue(), this.chosenRegistry())
    this.requestRender()
  }

  private cycleRegistry(delta: number): void {
    const options = this.controller.registryOptions()
    const total = options.length + 1
    this.registryIndex = ((this.registryIndex + delta) % total + total) % total
    this.customRegistry = this.registryIndex === options.length
    this.syncInputFocus()
    this.requestRender()
  }

  private chosenRegistry(): string | null {
    if (this.customRegistry) return this.registryInput.getValue().trim()
    return this.controller.registryOptions()[this.registryIndex]?.value ?? null
  }

  private syncInputFocus(): void {
    const install = this.controller.installView()
    const editing = install?.phase === 'editing'
    this.specInput.focused = this._focused && editing === true && this.installFocus === 'spec'
    this.registryInput.focused = this._focused && editing === true && this.installFocus === 'registry' && this.customRegistry
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    // Keep the text-input focus in step with the controller's install phase
    // (e.g. after `openInstall()`/`editInstall()` the spec Input must own the
    // hardware cursor without a keyboard event first).
    this.syncInputFocus()
    const install = this.controller.installView()
    const rendered = install === undefined
      ? this.renderList(safeWidth)
      : this.renderInstall(safeWidth, install)
    const limit = Number.isFinite(this.maxRows) ? Math.max(1, Math.floor(this.maxRows)) : Number.POSITIVE_INFINITY
    return this.windowLines(rendered.lines, rendered.selectedLine, limit)
  }

  /**
   * Selection-aware viewport: the header (title + blank) and the hint stay
   * fixed, while the body scrolls so the SELECTED row is always visible. When
   * content is clipped, `↑ more` / `↓ more` mark the hidden rows.
   */
  private windowLines(lines: readonly string[], selectedLine: number | undefined, limit: number): string[] {
    if (lines.length <= limit) return [...lines]
    const headerCount = 2
    const available = Math.max(1, limit - headerCount - 1)
    const header = lines.slice(0, headerCount)
    const hint = lines[lines.length - 1]!
    const body = lines.slice(headerCount, lines.length - 1)
    const selectedBody = selectedLine === undefined ? 0 : Math.max(0, selectedLine - headerCount)
    let budget = available
    const startFor = (rows: number): number => {
      const centered = selectedBody - Math.floor(rows / 2)
      return Math.min(Math.max(0, centered), Math.max(0, body.length - rows))
    }
    let start = startFor(budget)
    let top = start > 0
    let bottom = start + budget < body.length
    // Reserve rows for the indicators so the frame never exceeds the budget.
    while (budget > 1 && budget + (top ? 1 : 0) + (bottom ? 1 : 0) > available) {
      budget -= 1
      start = startFor(budget)
      top = start > 0
      bottom = start + budget < body.length
    }
    const out = [...header]
    if (top) out.push(color.textDim('  ↑ more'))
    out.push(...body.slice(start, start + budget))
    if (bottom) out.push(color.textDim('  ↓ more'))
    out.push(hint)
    return out
  }

  private renderList(width: number): { lines: string[]; selectedLine: number | undefined } {
    const rows = this.controller.rows()
    const selected = this.controller.selectedValue()
    const lines: string[] = []
    let selectedLine: number | undefined
    lines.push(color.textStrong(truncateToWidth(this.controller.title(), width, '…')))
    lines.push('')
    for (const row of rows) {
      if (row.kind === 'section') {
        lines.push(color.textStrong(truncateToWidth(row.label, width, '…')))
        continue
      }
      const isSelected = row.selectable && selected !== undefined && row.value === selected
      if (isSelected) selectedLine = lines.length
      const marker = row.selectable ? (isSelected ? color.accent('▸ ') : '  ') : '  '
      const label = row.kind === 'info' ? color.textMuted(truncateToWidth(row.label, Math.max(1, width - 2), '…'))
        : tone(truncateToWidth(row.label, Math.max(1, width - 2), '…'), row.tone)
      let line = `${marker}${label}`
      if (row.badge !== undefined) line += ` ${badge(row.badge, row.tone)}`
      if (row.secondary !== undefined) {
        const used = visibleWidth(line)
        const room = width - used - 3
        if (room > 8) line += `  ${color.textDim(truncateToWidth(row.secondary, room, '…'))}`
      }
      lines.push(line)
    }
    const notice = this.controller.notice()
    if (notice !== undefined) {
      lines.push('')
      lines.push(color.textMuted(truncateToWidth(notice, width, '…')))
    }
    const status = this.controller.status()
    if (status.state === 'loading' && rows.every(row => row.kind === 'section' || row.kind === 'info')) {
      lines.push(color.textDim(truncateToWidth('Loading plugins…', width, '…')))
    }
    lines.push('')
    lines.push(color.textDim(truncateToWidth(this.controller.hint(), width, '…')))
    return { lines, selectedLine }
  }

  private renderInstall(width: number, install: PluginInstallView): { lines: string[]; selectedLine: undefined } {
    const lines: string[] = []
    lines.push(color.textStrong(truncateToWidth(this.controller.title(), width, '…')))
    lines.push('')
    if (install.phase === 'editing') {
      lines.push(`Spec    ${this.specInput.render(Math.max(1, width - 8))[0] ?? ''}`)
      const options = this.controller.registryOptions()
      const registry = this.customRegistry
        ? `custom ${this.registryInput.render(Math.max(1, width - 16))[0] ?? ''}`
        : (options[this.registryIndex]?.label ?? 'pnpm configuration default')
      const focusHint = this.installFocus === 'registry' ? color.accent('‹') : ' '
      lines.push(`Reg     ${focusHint} ${truncateToWidth(registry, Math.max(1, width - 10), '…')}`)
      if (!this.customRegistry) {
        const hint = options.map(option => option.label).join(' · ')
        if (hint !== '') lines.push(color.textMuted(truncateToWidth(`        ${hint}`, width, '…')))
      }
      lines.push('')
      if (install.message !== undefined) lines.push(color.warning(truncateToWidth(install.message, width, '…')))
      lines.push(color.textDim(truncateToWidth('Tab switch field · ↑↓ choose registry · Enter inspect · Esc close', width, '…')))
      return { lines, selectedLine: undefined }
    }
    if (install.phase === 'inspecting') {
      lines.push(color.textDim(truncateToWidth(`Inspecting ${install.spec}…`, width, '…')))
      lines.push('')
      lines.push(color.textDim(truncateToWidth('Esc back', width, '…')))
      return { lines, selectedLine: undefined }
    }
    if (install.phase === 'confirm') {
      const inspection = install.inspection
      if (inspection?.status === 'accepted') {
        lines.push(color.textStrong(truncateToWidth(inspection.name ?? install.spec, width, '…')))
        if (inspection.version !== undefined) lines.push(color.textDim(truncateToWidth(`version ${inspection.version}`, width, '…')))
        if (inspection.description !== undefined) lines.push(color.textDim(truncateToWidth(inspection.description, width, '…')))
        lines.push(color.textDim(truncateToWidth(`source ${inspection.kind} · registry ${inspection.registry ?? 'pnpm default'}${inspection.host === undefined ? '' : ` · host ${inspection.host}`}`, width, '…')))
        lines.push(color.textDim(truncateToWidth(`bundle: ${inspection.bundle === null ? 'unknown' : inspection.bundle ? 'yes' : 'no'}`, width, '…')))
        lines.push('')
        lines.push(color.textDim(truncateToWidth('Enter install · Esc edit', width, '…')))
      } else if (inspection?.status === 'refused') {
        lines.push(color.error(truncateToWidth(`refused: ${inspection.problem}`, width, '…')))
        lines.push(color.textMuted(truncateToWidth(inspection.reason, width, '…')))
        if (inspection.registries !== undefined && inspection.registries.length > 0) {
          lines.push(color.textMuted(truncateToWidth(`registries: ${inspection.registries.map(r => r ?? 'pnpm default').join(', ')}`, width, '…')))
        }
        lines.push('')
        lines.push(color.textDim(truncateToWidth('Esc edit', width, '…')))
      }
      return { lines, selectedLine: undefined }
    }
    // running / settled
    lines.push(color.textStrong(truncateToWidth(`${install.phase}${install.spec === '' ? '' : ` · ${install.spec}`}`, width, '…')))
    if (install.message !== undefined) lines.push(color.textMuted(truncateToWidth(install.message, width, '…')))
    lines.push('')
    const hint = this.controller.hint()
    const budget = Number.isFinite(this.maxRows) ? Math.max(0, Math.floor(this.maxRows) - lines.length - 1) : install.log.length
    const log = install.log.slice(Math.max(0, install.log.length - budget))
    for (const line of log) lines.push(color.textDim(truncateToWidth(line, width, '…')))
    lines.push(color.textDim(truncateToWidth(hint, width, '…')))
    return { lines, selectedLine: undefined }
  }
}
