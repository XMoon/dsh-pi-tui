/**
 * The footer configurator MODEL (plan §15.4): a pure state machine over a
 * draft FooterLayoutV1 — toggle items, move between zones, reorder, switch
 * rows, cycle formats, set the separator, reset to the builtin presets.
 * The UI component only renders and forwards actions, so the whole model
 * is headless-testable.
 * @module @xmoon76/dsh-pi-tui/footer/configurator-model
 */

import type { FooterItemRegistry } from './item-registry.ts'
import { COMPACT_FOOTER_LAYOUT, DEFAULT_FOOTER_LAYOUT } from './presets.ts'
import type { FooterItemRef, FooterLayoutV1, FooterRowLayout, FooterSeparator } from './types.ts'

/** The configurator's observable state. */
export interface FooterConfiguratorState {
  readonly layout: FooterLayoutV1
  readonly activeRow: number
  readonly activeZone: 'left' | 'right'
  readonly activeIndex: number
}

/** The mutable draft shape (the persisted layout is deeply readonly). */
interface MutableRef {
  id: string
  format?: string
  tone?: string
  prefix?: string
  suffix?: string
  importance?: number
}
interface MutableRow {
  left: MutableRef[]
  right: MutableRef[]
  separator?: FooterSeparator
}
interface MutableLayout {
  schemaVersion: 1
  rows: MutableRow[]
}

function cloneRef(ref: FooterItemRef): MutableRef {
  return {
    id: ref.id,
    ...ref.format === undefined ? {} : { format: ref.format },
    ...ref.tone === undefined ? {} : { tone: ref.tone },
    ...ref.prefix === undefined ? {} : { prefix: ref.prefix },
    ...ref.suffix === undefined ? {} : { suffix: ref.suffix },
    ...ref.importance === undefined ? {} : { importance: ref.importance },
  }
}

function cloneRow(row: FooterRowLayout): MutableRow {
  return {
    left: row.left.map(cloneRef),
    right: row.right.map(cloneRef),
    ...row.separator === undefined ? {} : { separator: { ...row.separator } },
  }
}

function cloneLayout(layout: FooterLayoutV1): MutableLayout {
  return { schemaVersion: 1, rows: layout.rows.map(cloneRow) }
}

/** The footer configurator state machine. */
export class FooterConfiguratorModel {
  private readonly draft: MutableLayout
  private activeRow = 0
  private activeZone: 'left' | 'right' = 'left'
  private activeIndex = 0
  private readonly registry: FooterItemRegistry

  constructor(initial: FooterLayoutV1, registry: FooterItemRegistry) {
    this.draft = cloneLayout(initial)
    this.registry = registry
  }

  /** The current state (the draft layout is the live preview source). */
  state(): FooterConfiguratorState {
    return {
      layout: this.draft as unknown as FooterLayoutV1,
      activeRow: this.activeRow,
      activeZone: this.activeZone,
      activeIndex: this.activeIndex,
    }
  }

  /** The active row's mutable record. */
  private activeRowRecord(): MutableRow {
    return this.draft.rows[Math.min(this.activeRow, this.draft.rows.length - 1)]!
  }

  /** The active zone's refs (a copy). */
  private activeRefs(): MutableRef[] {
    const row = this.activeRowRecord()
    return this.activeZone === 'left' ? [...row.left] : [...row.right]
  }

  /** Replace the active zone's refs, clamping the cursor. */
  private setActiveRefs(refs: MutableRef[]): void {
    const row = this.activeRowRecord()
    if (this.activeZone === 'left') row.left = refs
    else row.right = refs
    this.activeIndex = Math.min(this.activeIndex, Math.max(0, refs.length - 1))
  }

  /** The active item's ref, when the active zone is non-empty. */
  private activeRef(): MutableRef | undefined {
    return this.activeRefs()[this.activeIndex]
  }

  /** Space: toggle the active item out of the layout. */
  toggleActive(): void {
    const ref = this.activeRef()
    if (ref === undefined) return
    this.setActiveRefs(this.activeRefs().filter(candidate => candidate !== ref))
  }

  /** ←/→: move the active item to the other zone (appended at the end). */
  moveToOtherZone(): void {
    const ref = this.activeRef()
    if (ref === undefined) return
    this.setActiveRefs(this.activeRefs().filter(candidate => candidate !== ref))
    const row = this.activeRowRecord()
    if (this.activeZone === 'left') row.right = [...row.right, ref]
    else row.left = [...row.left, ref]
  }

  /** ↑: move the cursor up (selection, no reorder). */
  moveCursorUp(): void {
    if (this.activeIndex <= 0) return
    this.activeIndex -= 1
  }

  /** ↓: move the cursor down (selection, no reorder). */
  moveCursorDown(): void {
    const refs = this.activeRefs()
    if (this.activeIndex >= refs.length - 1) return
    this.activeIndex += 1
  }

  /** Shift+↑: move the active item one position up. */
  moveUp(): void {
    const refs = this.activeRefs()
    if (this.activeIndex <= 0 || refs.length === 0) return
    const ref = refs[this.activeIndex]!
    refs.splice(this.activeIndex, 1)
    refs.splice(this.activeIndex - 1, 0, ref)
    this.activeIndex -= 1
    this.setActiveRefs(refs)
  }

  /** Shift+↓: move the active item one position down. */
  moveDown(): void {
    const refs = this.activeRefs()
    if (this.activeIndex >= refs.length - 1 || refs.length === 0) return
    const ref = refs[this.activeIndex]!
    refs.splice(this.activeIndex, 1)
    refs.splice(this.activeIndex + 1, 0, ref)
    this.activeIndex += 1
    this.setActiveRefs(refs)
  }

  /** Tab: switch to the next row (wraps). */
  switchRow(): void {
    if (this.draft.rows.length < 2) return
    this.activeRow = (this.activeRow + 1) % this.draft.rows.length
    this.activeIndex = 0
  }

  /** Shift+Tab: switch the active zone. */
  switchZone(): void {
    this.activeZone = this.activeZone === 'left' ? 'right' : 'left'
    this.activeIndex = 0
  }

  /** Cycle the active item's finite formatter. */
  cycleFormat(): void {
    const ref = this.activeRef()
    if (ref === undefined) return
    const def = this.registry.get(ref.id)
    if (def === undefined || def.formats.length <= 1) return
    const current = ref.format ?? def.defaultFormat
    const index = def.formats.indexOf(current)
    const next = def.formats[(index + 1) % def.formats.length]!
    if (next === def.defaultFormat) delete ref.format
    else ref.format = next
  }

  /** Set the active row's separator text ('' removes it). */
  setSeparator(text: string): void {
    const row = this.activeRowRecord()
    if (text === '') {
      delete row.separator
      return
    }
    row.separator = { text }
  }

  /** The draft layout (the live preview source). */
  preview(): FooterLayoutV1 {
    return this.draft as unknown as FooterLayoutV1
  }

  /** Reset the draft to the builtin default layout. */
  resetDefault(): void {
    const next = cloneLayout(DEFAULT_FOOTER_LAYOUT)
    this.draft.rows = next.rows
    this.activeRow = 0
    this.activeIndex = 0
  }

  /** Reset the draft to the builtin compact layout. */
  resetCompact(): void {
    const next = cloneLayout(COMPACT_FOOTER_LAYOUT)
    this.draft.rows = next.rows
    this.activeRow = 0
    this.activeIndex = 0
  }

  /** Add a second row (1..2 rows). */
  addRow(): void {
    if (this.draft.rows.length >= 2) return
    this.draft.rows = [...this.draft.rows, { left: [], right: [] }]
  }

  /** Remove the last row (1..2 rows). */
  removeRow(): void {
    if (this.draft.rows.length <= 1) return
    this.draft.rows = this.draft.rows.slice(0, -1)
    this.activeRow = Math.min(this.activeRow, this.draft.rows.length - 1)
    this.activeIndex = 0
  }
}
