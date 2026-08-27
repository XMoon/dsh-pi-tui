/**
 * The footer configurator UI (the hierarchical editor): a full-width
 * overlay panel with a FIXED shell — title, contextual help, and a live
 * preview — and a scrollable body that follows the cursor. The preview is
 * composed by the REAL FooterComposer against the current StatusSnapshot
 * (whole-footer on the row pages, the single item's own render on the
 * item pages). The panel only renders and forwards keys — every mutation
 * lives in the model (headless-testable).
 *
 * Pages (the plan's hierarchy):
 *   rows  — Row Selector (↑↓ select, Enter edit, S save, Esc cancel)
 *   row   — Edit Row (Left/Right as VISUAL grouping; ←→ moves sides)
 *   item  — Item Editor (Style / Tone / Advanced…)
 *   style — Style picker (live per-format examples)
 *   tone  — Tone picker (semantic tones)
 *   advanced — Prefix / Suffix / Importance inline editors + Reset
 *   add   — searchable Add picker (type to filter; Esc clears first)
 *   row-move — Move Mode (↑↓ reorder within the zone)
 *
 * All key matches go through the project's matchesKey vocabulary (legacy
 * AND Kitty CSI-u / modifyOtherKeys encodings — no raw sequence compares),
 * so CSI-u terminals keep every key working. No fork changes.
 * @module @xmoon76/dsh-pi-tui/footer/configurator
 */

import { matchesKey, truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
import { color } from '../theme.ts'
import type { StatusSnapshot } from '../status/types.ts'
import { FooterComposer, renderSpans } from './composer.ts'
import {
  FOOTER_TONE_CHOICES,
  flatLengthOf,
  flatPositionOf,
  itemMenuFor,
} from './configurator-model.ts'
import type { FooterConfiguratorModel } from './configurator-model.ts'
import type { FooterItemRegistry } from './item-registry.ts'
import { stripControlChars } from './layout.ts'
import type { FooterItemRef, FooterLayoutV1, FooterTone } from './types.ts'

/** The configurator panel's options. */
export interface FooterConfiguratorOptions {
  readonly model: FooterConfiguratorModel
  readonly registry: FooterItemRegistry
  /** The live snapshot getter (the preview follows streaming state). */
  readonly snapshot: () => StatusSnapshot
  readonly composer: FooterComposer
  /** LIVE getters, not captured values: the preview reflects the current
   * task-browser availability (the same routing-gate semantic the footer
   * hint uses) and extension footer text even while the panel is open. */
  readonly taskBrowserAvailable: () => boolean
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
  private readonly taskBrowserAvailable: () => boolean
  private readonly extensionFooterText: () => string
  private readonly maxVisible: () => number
  private readonly onSave: (layout: FooterLayoutV1) => void
  private readonly onCancel: () => void
  /** The body scrollport's top offset (stable across renders — the cursor
   * scrolls the body minimally; the fixed shell never moves). */
  private scrollTop = 0
  /** The fork dispatches input to the focused component's handleInput. */
  readonly handleInput: (data: string) => void

  constructor(options: FooterConfiguratorOptions) {
    this.model = options.model
    this.registry = options.registry
    this.snapshot = options.snapshot
    this.composer = options.composer
    this.taskBrowserAvailable = options.taskBrowserAvailable
    this.extensionFooterText = options.extensionFooterText
    this.maxVisible = options.maxVisible
    this.onSave = options.onSave
    this.onCancel = options.onCancel
    this.handleInput = (data: string): void => {
      const state = this.model.state()
      if (matchesKey(data, 'escape')) {
        // The model navigates back page by page; only the Row Selector's
        // Esc closes the configurator (cancel without saving).
        if (!this.model.cancel()) this.onCancel()
        return
      }
      if (matchesKey(data, 'enter')) {
        this.model.activate()
        return
      }
      // Text-input pages swallow printable keys FIRST (space is a query
      // character there, never the remove action). Any non-escape chunk
      // is text — including a paste burst (the model strips control
      // characters and enforces the parser's bounds).
      const textMode = state.mode === 'add' || (state.mode === 'advanced' && state.editing)
      if (textMode) {
        if (matchesKey(data, 'backspace')) {
          this.model.backspace()
          return
        }
        if (!data.includes('\x1b')) {
          this.model.text(data)
          return
        }
      }
      if (state.mode === 'rows' && matchesKey(data, 's')) {
        // The Row Selector is the save point: S persists the draft.
        this.onSave(this.model.preview())
        return
      }
      if (state.mode === 'row') {
        if (matchesKey(data, 'a')) {
          this.model.startAdd()
          return
        }
        if (matchesKey(data, 'm')) {
          this.model.startMove()
          return
        }
        if (matchesKey(data, 'f')) {
          this.model.cycleFormat()
          return
        }
        if (matchesKey(data, 'space')) {
          this.model.removeActive()
          return
        }
        // Legacy compat shortcuts (no longer advertised in the help —
        // Move Mode is the primary reorder interaction).
        if (matchesKey(data, 'shift+up')) {
          this.model.reorderActive(-1)
          return
        }
        if (matchesKey(data, 'shift+down')) {
          this.model.reorderActive(1)
          return
        }
      }
      if (matchesKey(data, 'up')) {
        this.model.moveUp()
        return
      }
      if (matchesKey(data, 'down')) {
        this.model.moveDown()
        return
      }
      if (matchesKey(data, 'left')) {
        this.model.moveZone('left')
        return
      }
      if (matchesKey(data, 'right')) {
        this.model.moveZone('right')
        return
      }
    }
  }

  invalidate(): void {
    // The fork re-renders after every handleInput dispatch; a model
    // mutation from outside (reset helpers) calls this.
  }

  render(width: number): string[] {
    const state = this.model.state()
    // The budget is re-read EVERY render (resize-safe); the caller's
    // getter already leaves room for the Frame's border rows.
    const budget = Math.max(1, this.maxVisible())
    const rule = color.border('─'.repeat(Math.max(0, width - 2)))
    const chrome = [
      color.textStrong(this.title(state)),
      color.textMuted(this.help(state)),
      color.textStrong('Preview'),
      ...this.previewLines(width),
      rule,
    ]
    const pre = this.preLines(state)
    const tail = this.tailLines(state)
    const body = this.bodyLines(state, width)
    const scrollBudget = Math.max(0, budget - chrome.length - pre.length - tail.length)
    const head = [...chrome, ...pre]
    if (scrollBudget === 0) {
      // A tiny terminal: the fixed shell wins, the body drops (the Frame
      // borders stay visible — the physical minimum).
      return head.slice(0, budget).map(line => truncateToWidth(line, Math.max(1, width), '…'))
    }
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, body.lines.length - scrollBudget)))
    if (body.cursor < this.scrollTop) this.scrollTop = body.cursor
    if (body.cursor >= this.scrollTop + scrollBudget) this.scrollTop = body.cursor - scrollBudget + 1
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, body.lines.length - scrollBudget)))
    return [...head, ...body.lines.slice(this.scrollTop, this.scrollTop + scrollBudget), ...tail]
      .map(line => truncateToWidth(line, Math.max(1, width), '…'))
  }

  /** The page title (the header). */
  private title(state: { mode: string; rowIndex: number; cursor: number }): string {
    switch (state.mode) {
      case 'row':
        return `Edit Row ${state.rowIndex + 1}`
      case 'row-move':
        return `Edit Row ${state.rowIndex + 1} [MOVE]`
      case 'item':
        return `Edit Item · ${this.itemLabel(state.rowIndex, state.cursor)}`
      case 'style':
        return `Style · ${this.itemLabel(state.rowIndex, state.cursor)}`
      case 'tone':
        return `Tone · ${this.itemLabel(state.rowIndex, state.cursor)}`
      case 'advanced':
        return `Advanced · ${this.itemLabel(state.rowIndex, state.cursor)}`
      case 'add':
        return `Add Item → Row ${state.rowIndex + 1}`
      default:
        return 'Configure Footer'
    }
  }

  /** The contextual help line (per page — never one long packed line). */
  private help(state: { mode: string; editing: boolean }): string {
    switch (state.mode) {
      case 'rows':
        return '↑↓ Select · Enter Edit · S Save · Esc Cancel'
      case 'row':
        return 'A Add · Enter Edit · M Move · ←→ Side · Space Remove · F Style · Esc Back'
      case 'row-move':
        return '↑↓ Move · ←→ Side · Enter/Esc Done'
      case 'item':
        return '↑↓ Select · Enter Open · ←→ Change · Esc Back'
      case 'style':
      case 'tone':
        return '↑↓ Select · Enter Apply · Esc Back'
      case 'advanced':
        return state.editing ? 'Type · Enter Confirm · Esc Cancel' : '↑↓ Select · Enter Edit · Esc Back'
      case 'add':
        return 'Type to search · ↑↓ Select · Enter Add · Esc Back'
      default:
        return ''
    }
  }

  /** The preview region: the whole composed footer on the row pages, the
   * single item's own render (with its ref decoration) on the item
   * pages. FIXED chrome — never scrolls with the body. */
  private previewLines(width: number): string[] {
    const state = this.model.state()
    if (state.mode === 'item' || state.mode === 'style' || state.mode === 'tone' || state.mode === 'advanced') {
      const ref = this.refAt(state.rowIndex, state.cursor)
      return [ref === undefined ? color.textMuted('(no item)') : this.itemPreview(ref)]
    }
    const preview = this.composer.render({
      snapshot: this.snapshot(),
      layout: this.model.preview(),
      width,
      context: { taskBrowserAvailable: this.taskBrowserAvailable(), extensionFooterText: this.extensionFooterText() },
    })
    const lines = preview.split('\n').filter((line, index, all) => !(line === '' && index === all.length - 1))
    return lines.length > 0 ? lines : [color.textMuted('(empty footer)')]
  }

  /** Pinned lines ABOVE the scrollport (the add picker's search input —
   * an input must never scroll away). */
  private preLines(state: { mode: string; addQuery: string }): string[] {
    if (state.mode !== 'add') return []
    return [`${color.textMuted('Search:')} ${state.addQuery === '' ? color.textMuted('(type to filter)') : color.textStrong(state.addQuery)}`]
  }

  /** Pinned lines BELOW the scrollport (the add picker's description of
   * the highlighted item). */
  private tailLines(state: { mode: string; pickerIndex: number }): string[] {
    if (state.mode !== 'add') return []
    const matches = this.model.addMatches()
    const id = matches[Math.min(state.pickerIndex, Math.max(0, matches.length - 1))]
    if (id === undefined) return []
    const description = this.registry.get(id)?.description
    if (description === undefined || description === '') return []
    return [color.textMuted(description)]
  }

  /** The scrollable body + the line index the cursor sits on. */
  private bodyLines(state: ReturnType<FooterConfiguratorModel['state']>, width: number): { lines: string[]; cursor: number } {
    switch (state.mode) {
      case 'rows': {
        const lines = [color.textStrong('Select row to edit')]
        state.layout.rows.forEach((row, index) => {
          const active = index === state.rowIndex
          const marker = active ? color.primary('›') : ' '
          const count = flatLengthOf(row)
          const noun = count === 1 ? 'item' : 'items'
          const label = `Row ${index + 1}`
          const tail = `${count} ${noun}`
          const pad = Math.max(1, width - visibleWidth(label) - tail.length - 4)
          const line = `${marker} ${active ? color.textStrong(label) : color.text(label)}${' '.repeat(pad)}${color.textMuted(tail)}`
          lines.push(line)
        })
        return { lines, cursor: 1 + state.rowIndex }
      }
      case 'row':
      case 'row-move': {
        const row = state.layout.rows[Math.min(state.rowIndex, state.layout.rows.length - 1)]!
        const lines: string[] = []
        let cursor = 0
        const emitZone = (zone: 'left' | 'right'): void => {
          lines.push(color.textStrong(zone === 'left' ? 'Left' : 'Right'))
          const refs = zone === 'left' ? row.left : row.right
          if (refs.length === 0) {
            lines.push(color.textMuted('  (empty)'))
            return
          }
          refs.forEach((ref, index) => {
            const flat = zone === 'left' ? index : row.left.length + index
            const active = flat === state.cursor
            if (active) cursor = lines.length
            const marker = active
              ? (state.mode === 'row-move' ? color.accent('◆') : color.primary('›'))
              : ' '
            const label = this.refLabel(ref)
            const style = this.styleText(ref)
            let line = `${marker} ${active ? color.textStrong(label) : color.text(label)}`
            if (style !== '') {
              const pad = Math.max(1, width - 2 - visibleWidth(label) - visibleWidth(style))
              line += `${' '.repeat(pad)}${color.textMuted(style)}`
            }
            lines.push(line)
          })
        }
        emitZone('left')
        emitZone('right')
        return { lines, cursor }
      }
      case 'item': {
        const ref = this.refAt(state.rowIndex, state.cursor)
        const menu = itemMenuFor(ref === undefined ? undefined : this.registry.get(ref.id)?.formats)
        const lines = menu.map((entry, index) => {
          const active = index === state.itemCursor
          const marker = active ? color.primary('›') : ' '
          if (entry.kind === 'style') {
            const value = this.formatDisplay(ref)
            return this.menuRow(marker, 'Style', value === '' ? undefined : color.text(value), active)
          }
          if (entry.kind === 'tone') {
            const tone = ref?.tone ?? 'auto'
            const label = FOOTER_TONE_CHOICES.find(choice => choice.value === tone)?.label ?? 'Auto'
            return this.menuRow(marker, 'Tone', this.tonePaint(tone, label), active)
          }
          return this.menuRow(marker, 'Advanced…', undefined, active)
        })
        return { lines, cursor: Math.min(state.itemCursor, Math.max(0, menu.length - 1)) }
      }
      case 'style': {
        const ref = this.refAt(state.rowIndex, state.cursor)
        const def = ref === undefined ? undefined : this.registry.get(ref.id)
        const formats = def?.formats ?? []
        const names = formats.map(format => this.humanizeFormat(format))
        const nameWidth = Math.max(...names.map(name => name.length), 1)
        const lines = formats.map((format, index) => {
          const active = index === state.pickerIndex
          const marker = active ? color.primary('›') : ' '
          const example = ref === undefined ? '' : this.formatExample(ref, format)
          // The plain name pads FIRST (alignment is computed on visible
          // text); the color wraps the padded label.
          const padded = `${names[index]!.padEnd(nameWidth + 2)}`
          return `${marker} ${active ? color.textStrong(padded) : color.text(padded)}${example === '' ? '' : ` ${example}`}`
        })
        return { lines, cursor: Math.min(state.pickerIndex, Math.max(0, formats.length - 1)) }
      }
      case 'tone': {
        const ref = this.refAt(state.rowIndex, state.cursor)
        const current = ref?.tone ?? 'auto'
        const lines = FOOTER_TONE_CHOICES.map((choice, index) => {
          const active = index === state.pickerIndex
          const marker = active ? color.primary('›') : ' '
          const painted = this.tonePaint(choice.value, choice.label)
          const suffix = (ref?.tone ?? 'auto') === choice.value ? color.textMuted('  (current)') : ''
          return `${marker} ${painted}${suffix}`
        })
        return { lines, cursor: Math.min(state.pickerIndex, Math.max(0, FOOTER_TONE_CHOICES.length - 1)) }
      }
      case 'advanced': {
        const ref = this.refAt(state.rowIndex, state.cursor)
        const fields: Array<{ field: 'prefix' | 'suffix' | 'importance' | 'reset'; label: string; value: string }> = [
          { field: 'prefix', label: 'Prefix', value: ref?.prefix ?? '' },
          { field: 'suffix', label: 'Suffix', value: ref?.suffix ?? '' },
          { field: 'importance', label: 'Importance', value: ref?.importance === undefined ? '' : String(ref.importance) },
          { field: 'reset', label: 'Reset to default', value: '' },
        ]
        const lines = fields.map((entry, index) => {
          const active = entry.field === state.advancedField
          const marker = active ? color.primary('›') : ' '
          if (entry.field === 'reset') {
            return `${marker} ${color.textMuted(entry.label)}`
          }
          const editing = active && state.editing
          const raw = editing ? state.editBuffer : entry.value
          const display = raw === ''
            ? color.textMuted(entry.field === 'importance' ? '(default)' : '(empty)')
            : color.textStrong(editing ? `${raw}▏` : raw)
          return this.menuRow(marker, entry.label, display, active)
        })
        return { lines, cursor: Math.min(fields.findIndex(entry => entry.field === state.advancedField), fields.length - 1) }
      }
      case 'add': {
        const matches = this.model.addMatches()
        if (matches.length === 0) return { lines: [color.textMuted('(no matching items)')], cursor: 0 }
        const lines = matches.map((id, index) => {
          const active = index === Math.min(state.pickerIndex, matches.length - 1)
          const marker = active ? color.primary('›') : ' '
          const def = this.registry.get(id)
          // An UNKNOWN id renders its raw text: strip control characters
          // (the parser rejects them in layouts, but a registry id from an
          // extension source is never trusted — an ESC/OSC id must not
          // reach the panel).
          const label = def === undefined ? stripControlChars(id) : def.label
          return `${marker} ${active ? color.textStrong(label) : color.text(label)}`
        })
        return { lines, cursor: Math.min(state.pickerIndex, matches.length - 1) }
      }
    }
  }

  /** One `› Label    value` menu row with a right-aligned value column. */
  private menuRow(marker: string, label: string, value: string | undefined, active: boolean): string {
    const name = active ? color.textStrong(label) : color.text(label)
    if (value === undefined) return `${marker} ${name}`
    const pad = Math.max(1, 14 - label.length)
    return `${marker} ${name}${' '.repeat(pad)}${value}`
  }

  /** A tone value painted in its own color (Auto = muted). */
  private tonePaint(tone: FooterTone | 'auto', label: string): string {
    if (tone === 'auto') return color.textMuted(label)
    return renderSpans([{ text: label, tone }])
  }

  /** The item's current format, humanized ('bar' → 'Bar'). */
  private formatDisplay(ref: FooterItemRef | undefined): string {
    if (ref === undefined) return ''
    const def = this.registry.get(ref.id)
    if (def === undefined) return ''
    return this.humanizeFormat(ref.format ?? def.defaultFormat)
  }

  private humanizeFormat(format: string): string {
    return format.charAt(0).toUpperCase() + format.slice(1)
  }

  /** A style candidate's live example: the definition's own render with
   * the candidate format applied (plus the ref's tone/prefix/suffix
   * decoration, exactly like the composer applies them). */
  private formatExample(ref: FooterItemRef, format: string): string {
    const def = this.registry.get(ref.id)
    if (def === undefined) return ''
    try {
      const segment = def.render(this.snapshot(), { ...ref, format }, 'preferred', {
        taskBrowserAvailable: this.taskBrowserAvailable(),
        extensionFooterText: this.extensionFooterText(),
      })
      if (segment === null) return color.textMuted('(unavailable)')
      return this.decorate(ref, segment.spans)
    } catch {
      return color.textMuted('(error)')
    }
  }

  /** The item's live preview: its own render with the ref's overrides
   * applied (tone replaces every span's tone; prefix/suffix wrap). */
  private itemPreview(ref: FooterItemRef): string {
    const def = this.registry.get(ref.id)
    if (def === undefined) return color.textMuted(clipText(stripControlChars(ref.id)))
    try {
      const segment = def.render(this.snapshot(), ref, 'preferred', {
        taskBrowserAvailable: this.taskBrowserAvailable(),
        extensionFooterText: this.extensionFooterText(),
      })
      if (segment === null) return color.textMuted('(unavailable)')
      const text = this.decorate(ref, segment.spans)
      return visibleWidth(text) === 0 ? color.textMuted('(unavailable)') : text
    } catch {
      return color.textMuted('(error)')
    }
  }

  /** Apply the ref decoration the composer applies: prefix + tone
   * override + suffix. */
  private decorate(ref: FooterItemRef, spans: readonly { text: string; tone?: FooterTone }[]): string {
    const override = ref.tone === undefined || ref.tone === 'auto' ? undefined : ref.tone
    return `${ref.prefix ?? ''}${renderSpans(spans, override)}${ref.suffix ?? ''}`
  }

  /** The ref at a row + flat position (undefined when absent). */
  private refAt(rowIndex: number, flat: number): FooterItemRef | undefined {
    const row = this.model.preview().rows[Math.min(rowIndex, this.model.preview().rows.length - 1)]
    if (row === undefined) return undefined
    const pos = flatPositionOf(flat, row)
    if (pos === undefined) return undefined
    return pos.zone === 'left' ? row.left[pos.index] : row.right[pos.index]
  }

  /** The display label of a ref: the definition's label, or the SANITIZED
   * raw id for an unknown id (an unloaded plugin — control characters
   * must never reach the panel). */
  private refLabel(ref: FooterItemRef): string {
    const def = this.registry.get(ref.id)
    return def === undefined ? stripControlChars(ref.id) : def.label
  }

  private itemLabel(rowIndex: number, flat: number): string {
    const ref = this.refAt(rowIndex, flat)
    if (ref === undefined) return '(no item)'
    return clipText(this.refLabel(ref))
  }

  /** The item's current style name for the Edit Row list (empty for an
   * unknown definition). */
  private styleText(ref: FooterItemRef): string {
    return this.formatDisplay(ref)
  }
}

/** Clip a title-part label (titles truncate ANSI-safely anyway). */
function clipText(text: string, max = 40): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}