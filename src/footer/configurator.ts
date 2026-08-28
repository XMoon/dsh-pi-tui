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
 *   item  — Item Editor (Style / Text / Default tone / Tone / Advanced…)
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

import {
  decodePrintableKey,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type KeyId,
} from '@xmoon76/pi-tui'
import { color } from '../theme.ts'
import type { StatusSnapshot } from '../status/types.ts'
import { FooterComposer, renderSpans } from './composer.ts'
import { sanitizeCommandOutput } from './ansi-sanitize.ts'
import {
  flatLengthOf,
  flatPositionOf,
  FOOTER_TONE_CHOICES,
  itemMenuFor,
  toneChoicesFor,
} from './configurator-model.ts'
import type { FooterConfiguratorModel } from './configurator-model.ts'
import { MAX_ITEMS_PER_ROW } from './layout.ts'
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
  /** Request a render after timer-driven input replay. */
  readonly requestRender?: () => void
  readonly onSave: (layout: FooterLayoutV1, customItems?: readonly import('./custom-items.ts').FooterCustomItemSettings[]) => void
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
  private readonly requestRender: () => void
  private readonly onSave: (layout: FooterLayoutV1, customItems?: readonly import('./custom-items.ts').FooterCustomItemSettings[]) => void
  private readonly onCancel: () => void
  /** The body scrollport's top offset (stable across renders — the cursor
   * scrolls the body minimally; the fixed shell never moves). */
  private scrollTop = 0
  /** Bracketed-paste buffering (the fork's Input-component pattern):
   * `isInPaste` between the \x1b[200~/\x1b[201~ markers, `pasteBuffer`
   * accumulating the chunks — the markers (and the content) may split
   * across terminal chunks. `pasteStartPending` holds an incomplete start
   * marker, including an ambiguous lone ESC for a bounded replay. */
  private isInPaste = false
  private pasteBuffer = ''
  private pasteStartPending = ''
  private pasteStartTimer: ReturnType<typeof setTimeout> | undefined
  /** Recursive scanner replays bypass paste recognition exactly once. */
  private skipPasteOnce = false
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
    this.requestRender = options.requestRender ?? (() => {})
    this.onSave = options.onSave
    this.onCancel = options.onCancel
    this.handleInput = (data: string): void => {
      const state = this.model.state()
      // Text-input pages swallow text keys FIRST (space is a query
      // character there, never the remove action). Text arrives in three
      // shapes — a plain printable chunk, a Kitty CSI-u / modifyOtherKeys
      // encoded printable (contains ESC!), and bracketed-paste bursts
      // (start marker, content, end marker — all ESC-led) — so "contains
      // ESC" is NOT a printable test: decodePrintableKey + the paste
      // protocol decide, exactly like the fork's Input component.
      const textMode = state.mode === 'add'
        || state.mode === 'create-name'
        || state.mode === 'create-text'
        || (state.mode === 'advanced' && state.editing)
        || ((state.mode === 'custom-text' || state.mode === 'custom-name') && state.editing)
      if (textMode && matchesKey(data, 'backspace')) {
        this.model.backspace()
        return
      }
      if (textMode && !this.skipPasteOnce && this.feedPaste(data)) return
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
      if (textMode) {
        // A plain printable chunk (one character OR a coalesced burst —
        // fast typists and non-bracketed pastes deliver multi-char runs)
        // is text: the model strips control characters and enforces the
        // parser's bounds.
        const printable = decodePrintableKey(data)
          ?? (data.length >= 1 && !/[\u0000-\u001f\u007f-\u009f]/.test(data) ? data : undefined)
        if (printable !== undefined) {
          this.model.text(printable)
          return
        }
        // A non-printable, unmatched chunk in text mode falls through to
        // the navigation keys below (arrows move the add list).
      }
      if (state.mode === 'rows' && matchesKey(data, 's')) {
        // The Row Selector is the save point: S persists the layout and the
        // definition catalog as one draft snapshot.
        this.onSave(this.model.preview(), this.model.customItemSettings())
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

  dispose(): void {
    this.clearPasteStartTimer()
    this.pasteStartPending = ''
    this.pasteBuffer = ''
    this.isInPaste = false
    this.skipPasteOnce = false
  }

  render(width: number): string[] {
    const state = this.model.state()
    // The budget is re-read EVERY render (resize-safe); the caller's
    // getter already leaves room for the Frame's border rows.
    const budget = Math.max(1, this.maxVisible())
    const rule = color.border('─'.repeat(Math.max(0, width - 2)))
    const head = [
      color.textStrong(this.title(state)),
      color.textMuted(this.help(state)),
    ]
    const pre = this.preLines(state)
    const tail = this.tailLines(state)
    const body = this.bodyLines(state, width)
    const previewRows = this.previewLines(width)
    // The EDITABLE body wins over the preview on a short terminal: the
    // fixed shell is title + help (+ rule + the add page's pinned
    // lines), the body keeps up to TWO rows (all of them when fewer) and
    // the PREVIEW compresses to whatever remains — a footer preview can
    // legally reach 4 physical rows, and letting it eat the shell would
    // leave a configurator with zero editable rows visible. The preview
    // block keeps its label only while at least one preview row fits;
    // a hidden remainder is marked with an ellipsis.
    const fixedCount = head.length + pre.length + tail.length + 1
    const left = budget - fixedCount
    if (left <= 0) {
      // A tiny terminal: the fixed shell wins, the body drops (the Frame
      // borders stay visible — the physical minimum).
      return [...head, ...pre].slice(0, budget).map(line => truncateToWidth(line, Math.max(1, width), '…'))
    }
    const bodyMin = Math.min(body.lines.length, 2)
    let bodyBudget: number
    let previewBlock: string[]
    if (left <= bodyMin + 1) {
      // No room for a meaningful preview — the editable rows take it all.
      bodyBudget = Math.min(body.lines.length, Math.max(1, left))
      previewBlock = []
    } else {
      const previewCount = Math.min(previewRows.length, left - bodyMin - 1)
      bodyBudget = left - 1 - previewCount
      previewBlock = previewCount > 0
        ? [
            color.textStrong('Preview'),
            ...previewRows.slice(0, previewCount).map((line, index) =>
              index === previewCount - 1 && previewRows.length > previewCount ? `${line}…` : line),
          ]
        : []
    }
    const scrollBudget = Math.max(1, Math.min(bodyBudget, body.lines.length))
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, body.lines.length - scrollBudget)))
    if (body.cursor < this.scrollTop) this.scrollTop = body.cursor
    if (body.cursor >= this.scrollTop + scrollBudget) this.scrollTop = body.cursor - scrollBudget + 1
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, body.lines.length - scrollBudget)))
    return [
      ...head,
      ...previewBlock,
      rule,
      ...pre,
      ...body.lines.slice(this.scrollTop, this.scrollTop + scrollBudget),
      ...tail,
    ].map(line => truncateToWidth(line, Math.max(1, width), '…'))
  }

  /** Feed one chunk through the bracketed-paste protocol. Returns true
   * when the chunk was consumed as paste traffic (a start marker,
   * buffered content, or the end marker) — the markers and the content
   * may split across terminal chunks. A completed paste feeds the WHOLE
   * content to the model as one text input (the model strips control
   * characters and enforces the parser's bounds). */
  private feedPaste(data: string): boolean {
    const pendingStart = this.pasteStartPending
    if (pendingStart !== '') {
      this.pasteStartPending = ''
      this.clearPasteStartTimer()
      const candidate = pendingStart + data
      if (continuesPasteStart(candidate)) {
        data = candidate
      } else {
        // A lone ESC is ambiguous: it may be the first byte of a split paste
        // marker or a real Escape key. Replay it without re-entering this
        // scanner, then feed the new chunk normally so a fresh marker suffix
        // cannot be lost. Longer malformed prefixes retain their old
        // fail-soft behavior: a reconstructed normal key is replayed as one
        // key, otherwise only the incoming chunk is dispatched.
        if (pendingStart === '\x1b') {
          this.replayWithoutPaste(pendingStart)
          if (data !== '') {
            if (isReplayableInput(data)) this.replayWithoutPaste(data)
            else this.handleInput(data)
          }
        } else if (isReplayableInput(candidate)) {
          this.replayWithoutPaste(candidate)
        } else if (data !== '') {
          if (isReplayableInput(data)) this.replayWithoutPaste(data)
          else this.handleInput(data)
        }
        return true
      }
    }

    // Once a paste has started, every byte belongs to the paste until the
    // end marker. The end marker is allowed to split because it stays in
    // pasteBuffer between calls.
    if (this.isInPaste) {
      this.pasteBuffer += data
      this.finishPastes()
      return true
    }

    const startIndex = data.indexOf(BRACKETED_PASTE_START)
    if (startIndex >= 0) {
      // Preserve ordinary input that arrived before a complete marker, then
      // consume the marker and continue scanning the same chunk. This path
      // also handles a complete marker reconstructed from pasteStartPending.
      const before = data.slice(0, startIndex)
      if (before !== '') this.handleInput(before)
      this.isInPaste = true
      this.pasteBuffer = data.slice(startIndex + BRACKETED_PASTE_START.length)
      this.finishPastes()
      return true
    }

    // A raw ESC is the one complete key that is also a possible first byte
    // of the paste marker, so hold it before the normal-key fast path.
    if (data === '\x1b') {
      this.holdPasteStart(data)
      return true
    }

    // A complete normal key sequence (including arrows and Kitty printables)
    // must not be mistaken for the shared ESC+[ paste prefix.
    if (isReplayableInput(data)) return false

    // Keep an incomplete ESC+[200~ suffix. A lone ESC is held briefly as an
    // ambiguous prefix; if no continuation arrives, the timer replays it as
    // the configurator's ordinary Escape navigation. Longer prefixes use a
    // longer bounded hold because they are already unlikely to be standalone
    // keys and existing split-marker callers need time between chunks.
    const partialLength = longestPasteStartSuffix(data)
    if (partialLength > 0) {
      const ordinary = data.slice(0, -partialLength)
      if (ordinary !== '') this.handleInput(ordinary)
      this.holdPasteStart(data.slice(-partialLength))
      return true
    }

    return false
  }

  /** Dispatch replayed bytes without sending them back into paste scanning. */
  private replayWithoutPaste(data: string): void {
    const previous = this.skipPasteOnce
    this.skipPasteOnce = true
    try {
      this.handleInput(data)
    } finally {
      this.skipPasteOnce = previous
    }
  }

  private holdPasteStart(prefix: string): void {
    this.pasteStartPending = prefix
    this.clearPasteStartTimer()
    const delay = prefix === '\x1b' ? PASTE_ESC_TIMEOUT_MS : PASTE_PREFIX_TIMEOUT_MS
    this.pasteStartTimer = setTimeout(() => {
      this.pasteStartTimer = undefined
      if (this.pasteStartPending !== prefix) return
      this.pasteStartPending = ''
      if (prefix === '\x1b') {
        this.replayWithoutPaste(prefix)
        this.requestRender()
      }
    }, delay)
  }

  private clearPasteStartTimer(): void {
    if (this.pasteStartTimer === undefined) return
    clearTimeout(this.pasteStartTimer)
    this.pasteStartTimer = undefined
  }

  /** Consume all complete paste end markers in the current buffer. */
  private finishPastes(): void {
    let remaining = ''
    while (this.isInPaste) {
      const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END)
      if (endIndex < 0) return
      const content = this.pasteBuffer.slice(0, endIndex)
      remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length)
      this.isInPaste = false
      this.pasteBuffer = ''
      this.model.text(content)
      if (remaining === '') return

      // A single terminal chunk can contain ordinary input or another paste
      // after the end marker. Re-enter the scanner without sending the same
      // bytes through the outer handleInput twice.
      const startIndex = remaining.indexOf(BRACKETED_PASTE_START)
      if (startIndex >= 0) {
        const before = remaining.slice(0, startIndex)
        if (before !== '') this.handleInput(before)
        this.isInPaste = true
        this.pasteBuffer = remaining.slice(startIndex + BRACKETED_PASTE_START.length)
        remaining = ''
        continue
      }
      const partialLength = longestPasteStartSuffix(remaining)
      if (partialLength > 0) {
        const ordinary = remaining.slice(0, -partialLength)
        if (ordinary !== '') this.handleInput(ordinary)
        this.holdPasteStart(remaining.slice(-partialLength))
        return
      }
      this.handleInput(remaining)
      return
    }
  }

  /** The page title (the header). */
  private title(state: { mode: string; rowIndex: number; cursor: number; addSide: 'left' | 'right' }): string {
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
      case 'custom-tone':
        return `Default tone · ${this.itemLabel(state.rowIndex, state.cursor)}`
      case 'advanced':
        return `Advanced · ${this.itemLabel(state.rowIndex, state.cursor)}`
      case 'custom-text':
        return `Text · ${this.itemLabel(state.rowIndex, state.cursor)}`
      case 'custom-name':
        return `Rename · ${this.itemLabel(state.rowIndex, state.cursor)}`
      case 'custom-delete':
        return `Delete · ${this.itemLabel(state.rowIndex, state.cursor)}`
      case 'create-name':
      case 'create-text':
      case 'create-tone':
        return 'Create Custom Text'
      case 'add':
        // The side is decided when the picker opens (the cursor item's
        // zone): showing it spares the user guessing where the item will
        // land.
        return `Add Item → Row ${state.rowIndex + 1} · ${state.addSide === 'left' ? 'Left' : 'Right'}`
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
      case 'custom-tone':
        return '↑↓ Select · Enter Apply · Esc Back'
      case 'advanced':
        return state.editing ? 'Type · Enter Confirm · Esc Cancel' : '↑↓ Select · Enter Edit · Esc Back'
      case 'custom-text':
      case 'custom-name':
        return 'Type · Enter Confirm · Esc Cancel'
      case 'custom-delete':
        return 'Enter Confirm · Esc Cancel'
      case 'create-name':
      case 'create-text':
        return 'Type · Enter Next · Esc Cancel'
      case 'create-tone':
        return '↑↓ Select · Enter Create · Esc Cancel'
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
    if (state.mode === 'item' || state.mode === 'style' || state.mode === 'tone'
      || state.mode === 'advanced' || state.mode === 'custom-text' || state.mode === 'custom-tone'
      || state.mode === 'custom-name' || state.mode === 'custom-delete') {
      const ref = this.refAt(state.rowIndex, state.cursor)
      return [ref === undefined ? color.textMuted('(no item)') : this.itemPreview(ref)]
    }
    if (state.mode === 'create-name' || state.mode === 'create-text' || state.mode === 'create-tone') {
      const tone = state.mode === 'create-tone'
        ? FOOTER_TONE_CHOICES[state.pickerIndex]?.value ?? state.customTone
        : state.customTone
      const text = state.customText === '' ? color.textMuted('(enter text)') : renderSpans([{
        text: stripControlChars(state.customText),
        ...(tone === 'auto' ? {} : { tone }),
      }])
      return [text]
    }
    const preview = this.composer.render({
      snapshot: this.snapshot(),
      layout: this.model.preview(),
      width,
      context: { taskBrowserAvailable: this.taskBrowserAvailable(), extensionFooterText: this.extensionFooterText() },
    })
    // The composed preview flows through the REAL composer (the contract:
    // the preview must show exactly what the footer will show), but the
    // draft may carry fields the persisted-layout parser would have
    // rejected (a hand-built FooterLayoutV1) and definitions render their
    // own span text — so the composed lines pass the SAME boundary the
    // command mode applies to user-influenced footer text: SGR + OSC 8
    // survive (the legitimate styling), every other ESC sequence and C0/
    // C1 control is stripped.
    const lines = preview.split('\n').map(line => sanitizeCommandOutput(line))
      .filter((line, index, all) => !(line === '' && index === all.length - 1))
    return lines.length > 0 ? lines : [color.textMuted('(empty footer)')]
  }

  /** Pinned lines ABOVE the scrollport (the add picker's search input —
   * an input must never scroll away). */
  private preLines(state: { mode: string; addQuery: string }): string[] {
    if (state.mode !== 'add') return []
    return [`${color.textMuted('Search:')} ${state.addQuery === '' ? color.textMuted('(type to filter)') : color.textStrong(state.addQuery)}`]
  }

  /** Pinned lines BELOW the scrollport (the add picker's description of
   * the highlighted item — or the full-row notice: the model refuses a
   * 33rd item, and a silent no-op would look broken). */
  private tailLines(state: ReturnType<FooterConfiguratorModel['state']>): string[] {
    if (state.mode !== 'add') return []
    const row = state.layout.rows[Math.min(state.rowIndex, state.layout.rows.length - 1)]!
    if (flatLengthOf(row) >= MAX_ITEMS_PER_ROW) {
      return [color.textMuted('(row is full — remove an item first)')]
    }
    if (this.model.isCreateOption()) {
      return [color.textMuted('Create a user-defined static footer item.')]
    }
    const matches = this.model.addMatches()
    const id = matches[Math.min(state.pickerIndex, Math.max(0, matches.length - 1))]
    if (id === undefined) return []
    const description = this.registry.get(id)?.description
    if (description === undefined || description === '') return []
    return [color.textMuted(stripControlChars(description))]
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
        const custom = ref !== undefined && this.model.isCustomItem(ref.id)
        const menu = itemMenuFor(ref === undefined ? undefined : this.registry.get(ref.id)?.formats, custom)
        const lines = menu.map((entry, index) => {
          const active = index === state.itemCursor
          const marker = active ? color.primary('›') : ' '
          if (entry.kind === 'style') {
            const value = this.formatDisplay(ref)
            return this.menuRow(marker, 'Style', value === '' ? undefined : color.text(value), active)
          }
          if (entry.kind === 'tone') {
            const tone = ref?.tone ?? 'auto'
            // A legal-but-unlisted persisted token must display as ITSELF
            // (Strong/Dim/…), never as the 'Auto' fallback.
            const label = toneChoicesFor(ref?.tone).find(choice => choice.value === tone)?.label ?? 'Auto'
            return this.menuRow(marker, toneMenuLabel(entry.kind), this.tonePaint(tone, label), active)
          }
          if (entry.kind === 'custom-text') {
            const value = this.model.customItem(ref?.id ?? '')?.text
            return this.menuRow(marker, 'Text', value === undefined ? undefined : color.text(value), active)
          }
          if (entry.kind === 'custom-tone') {
            const tone = this.model.customItem(ref?.id ?? '')?.tone ?? 'auto'
            const label = toneChoicesFor(tone).find(choice => choice.value === tone)?.label ?? 'Auto'
            return this.menuRow(marker, toneMenuLabel(entry.kind), this.tonePaint(tone, label), active)
          }
          if (entry.kind === 'custom-name') return this.menuRow(marker, 'Rename definition', undefined, active)
          if (entry.kind === 'custom-delete') return this.menuRow(marker, 'Delete definition', undefined, active)
          return this.menuRow(marker, 'Advanced…', undefined, active)
        })
        return { lines, cursor: Math.min(state.itemCursor, Math.max(0, menu.length - 1)) }
      }
      case 'style': {
        const ref = this.refAt(state.rowIndex, state.cursor)
        const def = ref === undefined ? undefined : this.registry.get(ref.id)
        const formats = def?.formats ?? []
        const names = formats.map(format => this.humanizeFormat(stripControlChars(format)))
        // Alignment is computed on VISIBLE widths (a format name may
        // contain wide characters — string.length would misalign every
        // row after it).
        const nameWidth = Math.max(...names.map(name => visibleWidth(name)), 1)
        const lines = formats.map((format, index) => {
          const active = index === state.pickerIndex
          const marker = active ? color.primary('›') : ' '
          const example = ref === undefined ? '' : this.formatExample(ref, format)
          // The plain name pads FIRST (alignment is computed on visible
          // text); the color wraps the padded label.
          const padded = `${names[index]!}${' '.repeat(Math.max(0, nameWidth + 2 - visibleWidth(names[index]!)))}`
          return `${marker} ${active ? color.textStrong(padded) : color.text(padded)}${example === '' ? '' : ` ${example}`}`
        })
        return { lines, cursor: Math.min(state.pickerIndex, Math.max(0, formats.length - 1)) }
      }
      case 'tone': {
        const ref = this.refAt(state.rowIndex, state.cursor)
        const choices = toneChoicesFor(ref?.tone)
        const lines = choices.map((choice, index) => {
          const active = index === state.pickerIndex
          const marker = active ? color.primary('›') : ' '
          const painted = this.tonePaint(choice.value, choice.label)
          const suffix = (ref?.tone ?? 'auto') === choice.value ? color.textMuted('  (current)') : ''
          return `${marker} ${painted}${suffix}`
        })
        return { lines, cursor: Math.min(state.pickerIndex, Math.max(0, choices.length - 1)) }
      }
      case 'custom-tone': {
        const ref = this.refAt(state.rowIndex, state.cursor)
        const current = this.model.customItem(ref?.id ?? '')?.tone ?? 'auto'
        const choices = toneChoicesFor(current)
        const lines = choices.map((choice, index) => {
          const active = index === state.pickerIndex
          const marker = active ? color.primary('›') : ' '
          const painted = this.tonePaint(choice.value, choice.label)
          const suffix = current === choice.value ? color.textMuted('  (current)') : ''
          return `${marker} ${painted}${suffix}`
        })
        return { lines, cursor: Math.min(state.pickerIndex, Math.max(0, choices.length - 1)) }
      }
      case 'custom-text':
      case 'custom-name': {
        const label = state.mode === 'custom-text' ? 'Text' : 'Name'
        const raw = stripControlChars(state.editBuffer)
        const value = raw === '' ? color.textMuted('(empty)') : color.textStrong(`${raw}▏`)
        const lines = [this.menuRow(color.primary('›'), label, value, true)]
        if (state.customError !== '') lines.push(color.error(state.customError))
        return { lines, cursor: 0 }
      }
      case 'custom-delete': {
        const ref = this.refAt(state.rowIndex, state.cursor)
        const id = ref?.id ?? ''
        const count = this.referenceCount(id)
        const lines = [
          color.error(`Delete ${this.itemLabel(state.rowIndex, state.cursor)}?`),
          color.textMuted(count === 0
            ? 'This definition is not currently placed in the layout.'
            : `${count} layout reference${count === 1 ? '' : 's'} will be removed.`),
        ]
        if (state.customError !== '') lines.push(color.error(state.customError))
        return { lines, cursor: 0 }
      }
      case 'create-name': {
        const lines = [
          this.menuRow(color.primary('›'), 'Name', state.customName === '' ? color.textMuted('(required)') : color.textStrong(`${stripControlChars(state.customName)}▏`), true),
          color.textMuted('Use a stable name; it is stored as user:<name>.'),
        ]
        if (state.customError !== '') lines.push(color.error(state.customError))
        return { lines, cursor: 0 }
      }
      case 'create-text': {
        const name = state.customName === '' ? color.textMuted('(unnamed)') : color.text(state.customName)
        const value = state.customText === '' ? color.textMuted('(required)') : color.textStrong(`${stripControlChars(state.customText)}▏`)
        const lines = [
          this.menuRow(' ', 'Name', name, false),
          this.menuRow(color.primary('›'), 'Text', value, true),
        ]
        if (state.customError !== '') lines.push(color.error(state.customError))
        return { lines, cursor: 1 }
      }
      case 'create-tone': {
        const lines = [
          this.menuRow(' ', 'Name', color.text(state.customName), false),
          this.menuRow(' ', 'Text', color.text(state.customText), false),
          color.textStrong('Tone'),
          ...FOOTER_TONE_CHOICES.map((choice, index) => {
            const active = index === state.pickerIndex
            const marker = active ? color.primary('›') : ' '
            const suffix = choice.value === (FOOTER_TONE_CHOICES[state.pickerIndex]?.value ?? 'auto')
              ? color.textMuted('  (selected)')
              : ''
            return `${marker} ${this.tonePaint(choice.value, choice.label)}${suffix}`
          }),
        ]
        if (state.customError !== '') lines.push(color.error(state.customError))
        return { lines, cursor: Math.min(3 + state.pickerIndex, lines.length - 1) }
      }
      case 'advanced': {
        const ref = this.refAt(state.rowIndex, state.cursor)
        const fields: Array<{ field: 'prefix' | 'suffix' | 'importance' | 'reset'; label: string; value: string }> = [
          // The committed values are display text from an arbitrary
          // FooterLayoutV1 (the parser rejects control characters in
          // prefix/suffix, but the model accepts any layout): stripped at
          // this display boundary exactly like the item preview.
          { field: 'prefix', label: 'Prefix', value: ref?.prefix === undefined ? '' : stripControlChars(ref.prefix) },
          { field: 'suffix', label: 'Suffix', value: ref?.suffix === undefined ? '' : stripControlChars(ref.suffix) },
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
          // The inline buffer is control-char-free by construction (the
          // model strips on input and seeds from the stripped value), but
          // the display boundary strips again — never trust a buffer.
          const raw = stripControlChars(editing ? state.editBuffer : entry.value)
          const display = raw === ''
            ? color.textMuted(entry.field === 'importance' ? '(default)' : '(empty)')
            : color.textStrong(editing ? `${raw}▏` : raw)
          return this.menuRow(marker, entry.label, display, active)
        })
        return { lines, cursor: Math.min(fields.findIndex(entry => entry.field === state.advancedField), fields.length - 1) }
      }
      case 'add': {
        const matches = this.model.addMatches()
        const lines = matches.map((id, index) => {
          const active = index === state.pickerIndex
          const marker = active ? color.primary('›') : ' '
          const def = this.registry.get(id)
          // An UNKNOWN id renders its raw text: strip control characters
          // (the parser rejects them in layouts, but an extension source is
          // never trusted — an ESC/OSC id must not reach the panel).
          const label = def === undefined ? stripControlChars(id) : stripControlChars(def.label)
          return `${marker} ${active ? color.textStrong(label) : color.text(label)}`
        })
        const createIndex = matches.length
        if (matches.length === 0) lines.push(color.textMuted('(no matching items)'))
        const createActive = state.pickerIndex === createIndex
        lines.push(`${createActive ? color.primary('›') : ' '} ${createActive ? color.textStrong('+ Create Custom Text') : color.text('+ Create Custom Text')}`)
        return { lines, cursor: Math.min(state.pickerIndex, createIndex) }
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

  /** The item's current format, humanized ('bar' → 'Bar'). A format id
   * is DISPLAY text too (the parser accepts unknown format strings, an
   * extension declares its own) — control characters are stripped at the
   * display boundary. */
  private formatDisplay(ref: FooterItemRef | undefined): string {
    if (ref === undefined) return ''
    const def = this.registry.get(ref.id)
    if (def === undefined) return ''
    return this.humanizeFormat(stripControlChars(ref.format ?? def.defaultFormat))
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
   * override + suffix. Everything here is DISPLAY text — the parser
   * rejects control characters in persisted prefix/suffix but ACCEPTS
   * unknown format strings (and the model accepts any FooterLayoutV1), so
   * a definition that echoes the ref's format into a span could paint an
   * ESC/OSC sequence into the preview. Prefix, suffix AND every span's
   * text are stripped at this last display boundary. */
  private decorate(ref: FooterItemRef, spans: readonly { text: string; tone?: FooterTone }[]): string {
    const override = ref.tone === undefined || ref.tone === 'auto' ? undefined : ref.tone
    const prefix = ref.prefix === undefined ? '' : stripControlChars(ref.prefix)
    const suffix = ref.suffix === undefined ? '' : stripControlChars(ref.suffix)
    const rendered = renderSpans(spans.map(span => ({ ...span, text: stripControlChars(span.text) })), override)
    return `${prefix}${rendered}${suffix}`
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
   * must never reach the panel). The definition label is display text
   * from an external source too (a plugin contribution): stripped at the
   * boundary as well. */
  private refLabel(ref: FooterItemRef): string {
    const def = this.registry.get(ref.id)
    if (def === undefined) return stripControlChars(ref.id)
    return stripControlChars(def.label)
  }

  private itemLabel(rowIndex: number, flat: number): string {
    const ref = this.refAt(rowIndex, flat)
    if (ref === undefined) return '(no item)'
    return clipText(this.refLabel(ref))
  }

  /** Count all layout references to a definition before a delete. */
  private referenceCount(id: string): number {
    return this.model.preview().rows.reduce((count, row) => count
      + row.left.filter(ref => ref.id === id).length
      + row.right.filter(ref => ref.id === id).length, 0)
  }

  /** The item's current style name for the Edit Row list (empty for an
   * unknown definition). */
  private styleText(ref: FooterItemRef): string {
    return this.formatDisplay(ref)
  }
}

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const PASTE_ESC_TIMEOUT_MS = 10
const PASTE_PREFIX_TIMEOUT_MS = 250
const REPLAYABLE_ESC_KEYS: readonly KeyId[] = [
  'tab', 'enter', 'backspace', 'delete', 'insert', 'home', 'end',
  'pageUp', 'pageDown', 'up', 'down', 'left', 'right',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
]

/** Whether a pending-prefix candidate is a complete normal key sequence. */
function isReplayableInput(data: string): boolean {
  return matchesKey(data, 'escape')
    || decodePrintableKey(data) !== undefined
    || REPLAYABLE_ESC_KEYS.some(key => matchesKey(data, key))
}

/** Whether the candidate still begins with a valid paste start marker. */
function continuesPasteStart(data: string): boolean {
  const length = Math.min(data.length, BRACKETED_PASTE_START.length)
  return data.slice(0, length) === BRACKETED_PASTE_START.slice(0, length)
}

/** Return the longest proper start-marker prefix at the end of a chunk.
 * A one-byte ESC is included because it is ambiguous at a chunk boundary;
 * the panel holds it briefly and replays it as Escape if no marker follows. */
function longestPasteStartSuffix(data: string): number {
  for (let length = Math.min(BRACKETED_PASTE_START.length - 1, data.length); length >= 1; length -= 1) {
    if (data.endsWith(BRACKETED_PASTE_START.slice(0, length))) return length
  }
  return 0
}

/** The item page keeps definition tone and placement tone visibly distinct. */
function toneMenuLabel(kind: string): string {
  return kind === 'custom-tone' ? 'Default tone' : 'Tone'
}

/** Clip a title-part label (titles truncate ANSI-safely anyway). */
function clipText(text: string, max = 40): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}