/**
 * The footer configurator UI (plan §15.3/§15.5): a full-width overlay
 * panel that renders the configurator MODEL's draft layout, a live preview
 * composed by the REAL FooterComposer against the current StatusSnapshot,
 * and the key hints. The panel only renders and forwards actions — every
 * mutation lives in the model (headless-testable).
 *
 * Keys (the project's matchesKey vocabulary — no fork changes):
 * Space toggle · ←/→ move zone · Shift+↑/↓ reorder · Tab row / Shift+Tab
 * zone · F cycle format · Enter save · Esc cancel.
 * @module @xmoon76/dsh-pi-tui/footer/configurator
 */

import { matchesKey, truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
import { color } from '../theme.ts'
import type { StatusSnapshot } from '../status/types.ts'
import { FooterComposer, renderSpans } from './composer.ts'
import type { FooterConfiguratorModel } from './configurator-model.ts'
import type { FooterItemRegistry } from './item-registry.ts'
import type { FooterLayoutV1 } from './types.ts'

/** The configurator panel's options. */
export interface FooterConfiguratorOptions {
  readonly model: FooterConfiguratorModel
  readonly registry: FooterItemRegistry
  /** The live snapshot getter (the preview follows streaming state). */
  readonly snapshot: () => StatusSnapshot
  readonly composer: FooterComposer
  /** LIVE getters, not captured values: the preview reflects the current
   * editor emptiness and extension footer text even while the panel is
   * open (a draft typed under the overlay, an extension segment update). */
  readonly editorEmpty: () => boolean
  readonly extensionFooterText: () => string
  /** The overlay's row budget source: re-read at EVERY render so a
   * terminal resize never leaves the panel clipped or oversized. */
  readonly maxVisible: () => number
  readonly onSave: (layout: FooterLayoutV1) => void
  readonly onCancel: () => void
}

/** The footer configurator overlay panel. */
export class FooterConfiguratorPanel implements Component {
  private readonly model: FooterConfiguratorModel
  private readonly registry: FooterItemRegistry
  private readonly snapshot: () => StatusSnapshot
  private readonly composer: FooterComposer
  private readonly editorEmpty: () => boolean
  private readonly extensionFooterText: () => string
  private readonly maxVisible: () => number
  private readonly onSave: (layout: FooterLayoutV1) => void
  private readonly onCancel: () => void
  /** The fork dispatches input to the focused component's handleInput. */
  readonly handleInput: (data: string) => void

  constructor(options: FooterConfiguratorOptions) {
    this.model = options.model
    this.registry = options.registry
    this.snapshot = options.snapshot
    this.composer = options.composer
    this.editorEmpty = options.editorEmpty
    this.extensionFooterText = options.extensionFooterText
    this.maxVisible = options.maxVisible
    this.onSave = options.onSave
    this.onCancel = options.onCancel
    this.handleInput = (data: string): void => {
      if (matchesKey(data, 'escape')) {
        this.onCancel()
        return
      }
      if (matchesKey(data, 'enter')) {
        this.onSave(this.model.preview())
        return
      }
      if (matchesKey(data, 'space')) {
        this.model.toggleActive()
        return
      }
      if (matchesKey(data, 'up')) {
        this.model.moveCursorUp()
        return
      }
      if (matchesKey(data, 'down')) {
        this.model.moveCursorDown()
        return
      }
      if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
        this.model.moveToOtherZone()
        return
      }
      if (matchesKey(data, 'shift+up')) {
        this.model.moveUp()
        return
      }
      if (matchesKey(data, 'shift+down')) {
        this.model.moveDown()
        return
      }
      if (matchesKey(data, 'tab')) {
        this.model.switchRow()
        return
      }
      if (matchesKey(data, 'shift+tab')) {
        this.model.switchZone()
        return
      }
      if (matchesKey(data, 'f')) {
        this.model.cycleFormat()
        return
      }
    }
  }

  invalidate(): void {
    // The fork re-renders after every handleInput dispatch; a model
    // mutation from outside (reset buttons) calls this.
  }

  render(width: number): string[] {
    const state = this.model.state()
    const lines: string[] = []
    const rule = color.border('─'.repeat(Math.max(0, width - 2)))
    lines.push(color.textStrong('Configure Footer'))
    lines.push(rule)
    state.layout.rows.forEach((row, rowIndex) => {
      const active = rowIndex === state.activeRow
      const zoneLabel = (zone: 'left' | 'right'): string =>
        `${active && state.activeZone === zone && !state.cursorInAvailable ? color.primary('›') : ' '} Row ${rowIndex + 1} · ${zone === 'left' ? 'Left' : 'Right'}`
      lines.push(zoneLabel('left'))
      this.renderZone(row.left, rowIndex, 'left', state, width, lines)
      lines.push(zoneLabel('right'))
      this.renderZone(row.right, rowIndex, 'right', state, width, lines)
    })
    // The available section: every registry item not in the layout
    // (builtin AND extension items) — Space adds it to the active zone.
    const available = this.model.availableIds()
    if (available.length > 0) {
      lines.push(rule)
      lines.push(color.textStrong('Available'))
      available.forEach((id, index) => {
        const active = state.cursorInAvailable && index === state.availableIndex
        const def = this.registry.get(id)
        const label = def?.label ?? id
        const marker = active ? color.primary('›') : ' '
        const line = `${marker} ${color.textMuted('[ ]')} ${active ? color.textStrong(label) : color.text(label)}`
        lines.push(truncateToWidth(line, Math.max(1, width), '…'))
      })
    }
    lines.push(rule)
    lines.push(color.textStrong('Preview'))
    lines.push(rule)
    const preview = this.composer.render({
      snapshot: this.snapshot(),
      layout: this.model.preview(),
      width,
      context: { editorEmpty: this.editorEmpty(), extensionFooterText: this.extensionFooterText() },
    })
    for (const row of preview.split('\n')) lines.push(row)
    lines.push(rule)
    lines.push(color.textMuted('↑/↓ select · Space toggle · ←/→ move zone · Shift+↑/↓ reorder · Tab row / Shift+Tab zone · F format · Enter save · Esc cancel'))
    // The overlay clamps to its height budget: window the content around
    // the cursor so the active row is always visible (the plan's unified
    // scrollport discipline). The budget is re-read EVERY render — a
    // resize while the panel is open is picked up immediately.
    const cursorRow = this.cursorRow(state, lines)
    // The budget is re-read EVERY render (resize-safe); the caller's
    // getter already leaves room for the Frame's border rows, so the
    // windowing floor is 1 — a very short terminal never overflows.
    const budget = Math.max(1, this.maxVisible())
    if (lines.length <= budget) return lines
    const top = Math.max(0, Math.min(cursorRow - Math.floor(budget / 2), lines.length - budget))
    return lines.slice(top, top + budget)
  }

  /** The content row the cursor currently sits on. */
  private cursorRow(
    state: { activeRow: number; activeZone: 'left' | 'right'; activeIndex: number; cursorInAvailable: boolean; availableIndex: number },
    lines: string[],
  ): number {
    if (state.cursorInAvailable) {
      // The Available section: find its header, then the item offset.
      const header = lines.findIndex(line => line.includes('Available'))
      return header + 1 + state.availableIndex
    }
    // The active zone's section: the header row + the item offset.
    const header = lines.findIndex(line => line.includes(`Row ${state.activeRow + 1} · ${state.activeZone === 'left' ? 'Left' : 'Right'}`))
    return header + 1 + state.activeIndex
  }

  /** Render one zone's items: `[x] label  preview` rows, the active row
   * carrying the cursor marker. */
  private renderZone(
    refs: readonly { id: string; format?: string }[],
    rowIndex: number,
    zone: 'left' | 'right',
    state: { activeRow: number; activeZone: 'left' | 'right'; activeIndex: number; cursorInAvailable: boolean },
    width: number,
    lines: string[],
  ): void {
    if (refs.length === 0) {
      lines.push(color.textMuted('  (empty)'))
      return
    }
    refs.forEach((ref, index) => {
      const active = rowIndex === state.activeRow && zone === state.activeZone
        && !state.cursorInAvailable && index === state.activeIndex
      const def = this.registry.get(ref.id)
      const label = def?.label ?? ref.id
      const preview = this.itemPreview(ref)
      const marker = active ? color.primary('›') : ' '
      const checked = color.text('[x]')
      const line = `${marker} ${checked} ${active ? color.textStrong(label) : color.text(label)}${preview === '' ? '' : `  ${preview}`}`
      lines.push(truncateToWidth(line, Math.max(1, width), '…'))
    })
  }

  /** The item's live preview text (its own render against the snapshot). */
  private itemPreview(ref: { id: string; format?: string }): string {
    const def = this.registry.get(ref.id)
    if (def === undefined) return ''
    try {
      const segment = def.render(this.snapshot(), ref, 'preferred', {
        editorEmpty: this.editorEmpty(),
        extensionFooterText: this.extensionFooterText(),
      })
      if (segment === null) return color.textMuted('(unavailable)')
      const text = renderSpans(segment.spans)
      return visibleWidth(text) === 0 ? '' : text
    } catch {
      return color.textMuted('(error)')
    }
  }
}
