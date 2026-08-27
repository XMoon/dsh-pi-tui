/**
 * The footer configurator MODEL (the hierarchical editor): a pure state
 * machine over a draft FooterLayoutV1 organized as PAGES —
 *
 *   rows (Row Selector) → row (Edit Row) → item (Item Editor)
 *                                          ├─ style (Style picker)
 *                                          ├─ tone  (Tone picker)
 *                                          └─ advanced (Prefix/Suffix/
 *                                                       Importance/Reset)
 *   row → add (searchable Add picker)
 *   row ⇄ row-move (Move Mode)
 *
 * The UI component only renders and forwards keys; the whole model is
 * headless-testable. The persisted shape (FooterLayoutV1 / FooterItemRef)
 * is untouched: `format` is the only style field, `tone` the only tone
 * field, and unknown/throwing definitions degrade to inert rows.
 * @module @xmoon76/dsh-pi-tui/footer/configurator-model
 */

import type { FooterItemRegistry } from './item-registry.ts'
import { MAX_ITEMS_PER_ROW, stripControlChars } from './layout.ts'
import { COMPACT_FOOTER_LAYOUT, DEFAULT_FOOTER_LAYOUT } from './presets.ts'
import type { FooterItemRef, FooterLayoutV1, FooterRowLayout, FooterSeparator, FooterTone } from './types.ts'

/** The configurator's pages. */
export type FooterConfiguratorMode =
  | 'rows'
  | 'row'
  | 'row-move'
  | 'item'
  | 'style'
  | 'tone'
  | 'advanced'
  | 'add'

/** The advanced editor's fields (v1: the EXISTING ref fields only — no
 * new schema). `reset` is the trailing "Reset to default" action row. */
export type FooterAdvancedField = 'prefix' | 'suffix' | 'importance' | 'reset'

/** The configurator's observable state. */
export interface FooterConfiguratorState {
  readonly layout: FooterLayoutV1
  readonly mode: FooterConfiguratorMode
  /** The highlighted row (rows page) / the row being edited (every other
   * page). */
  readonly rowIndex: number
  /** Flat cursor over the EDITED row's items: left refs first, then right
   * refs — one linear list (the plan's "left/right is visual grouping,
   * not two focus sections"). */
  readonly cursor: number
  /** The item editor's menu cursor (Style / Tone / Advanced…). */
  readonly itemCursor: number
  /** The picker cursor (style formats / tone choices / add matches). */
  readonly pickerIndex: number
  /** The add picker's search query (case-insensitive substring over
   * label, id and description). */
  readonly addQuery: string
  /** The side new items are added to: the selection's side when the
   * picker opened, Left for an empty row. */
  readonly addSide: 'left' | 'right'
  /** The advanced editor's selected field. */
  readonly advancedField: FooterAdvancedField
  /** Whether an advanced field's INLINE text editor is open. */
  readonly editing: boolean
  /** The inline editor's buffer (raw; committed on Enter). */
  readonly editBuffer: string
}

/** The tone picker's choices: persisted values use the EXISTING semantic
 * tokens (`auto` = the ref carries no tone override); the labels are the
 * user-facing names. */
export const FOOTER_TONE_CHOICES: ReadonlyArray<{ readonly value: FooterTone | 'auto'; readonly label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'primary', label: 'Primary' },
  { value: 'accent', label: 'Accent' },
  { value: 'text', label: 'Text' },
  { value: 'textMuted', label: 'Muted' },
  { value: 'success', label: 'Success' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
]

/** Friendly names for the legal-but-UNLISTED semantic tokens (the parser
 * accepts all 12; the picker deliberately exposes the 8 user-facing
 * ones). */
const UNLISTED_TONE_LABELS: Partial<Record<FooterTone, string>> = {
  textStrong: 'Strong',
  textDim: 'Dim',
  border: 'Border',
  roleUser: 'Role user',
  shellMode: 'Shell mode',
}

/** The tone choices for one item's CURRENT tone: the 8 user-facing tones,
 * plus — when the ref carries a legal but UNLISTED persisted token — that
 * exact value, so a legal persisted value is never DISPLAYED as 'Auto'
 * and never silently deleted by a fake-'Auto' apply. */
export function toneChoicesFor(current: FooterTone | 'auto' | undefined): ReadonlyArray<{
  readonly value: FooterTone | 'auto'
  readonly label: string
}> {
  if (current === undefined || current === 'auto' || FOOTER_TONE_CHOICES.some(choice => choice.value === current)) {
    return FOOTER_TONE_CHOICES
  }
  return [...FOOTER_TONE_CHOICES, { value: current, label: UNLISTED_TONE_LABELS[current] ?? current }]
}

/** Hard input caps — the persisted-layout parser's bounds (a draft the
 * configurator builds must always re-parse). */
export const MAX_PREFIX_SUFFIX_LENGTH = 16
const MAX_IMPORTANCE = 1000

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

/** A zone + index pair: where a flat position lives inside one row. */
export interface FlatPosition {
  readonly zone: 'left' | 'right'
  readonly index: number
}

/** Map a flat position (left refs, then right refs) onto one row's zones.
 * undefined past the row's item count AND for negative positions (the
 * exported helper's contract: any out-of-range flat is undefined, never a
 * negative zone index). */
export function flatPositionOf(flat: number, row: FooterRowLayout): FlatPosition | undefined {
  if (flat < 0) return undefined
  if (flat < row.left.length) return { zone: 'left', index: flat }
  const rightIndex = flat - row.left.length
  if (rightIndex < row.right.length) return { zone: 'right', index: rightIndex }
  return undefined
}

/** The flat item count of one row (left refs + right refs). */
export function flatLengthOf(row: FooterRowLayout): number {
  return row.left.length + row.right.length
}

/** One item-editor menu entry (Style appears only for items with more
 * than one finite format — a single format has nothing to pick). */
export type ItemMenuEntry = { readonly kind: 'style' } | { readonly kind: 'tone' } | { readonly kind: 'advanced' }

/** The item editor's menu for one definition (undefined = an unknown id:
 * its format set is unknowable, so Style is hidden). */
export function itemMenuFor(formats: readonly string[] | undefined): ItemMenuEntry[] {
  const entries: ItemMenuEntry[] = []
  if (formats !== undefined && formats.length > 1) entries.push({ kind: 'style' })
  entries.push({ kind: 'tone' })
  entries.push({ kind: 'advanced' })
  return entries
}

/** The footer configurator state machine. */
export class FooterConfiguratorModel {
  private readonly draft: MutableLayout
  private mode: FooterConfiguratorMode = 'rows'
  private rowIndex = 0
  private cursor = 0
  private itemCursor = 0
  private pickerIndex = 0
  private addQuery = ''
  private addSide: 'left' | 'right' = 'left'
  private advancedField: FooterAdvancedField = 'prefix'
  private editing = false
  private editBuffer = ''
  private readonly registry: FooterItemRegistry

  constructor(initial: FooterLayoutV1, registry: FooterItemRegistry) {
    // A parser-valid layout always has 1..2 rows, but the model accepts
    // any FooterLayoutV1 (hand-built test layouts, foreign callers): a
    // zero-row draft would make editedRow() return undefined and crash
    // the first page transition. Normalize to ONE empty row — every
    // subsequent invariant (editedRow, clamps, the row-page rendering)
    // can then rely on rows.length >= 1.
    this.draft = cloneLayout(initial.rows.length === 0
      ? { schemaVersion: 1, rows: [{ left: [], right: [] }] }
      : initial)
    this.registry = registry
  }

  /** The current state (the draft layout is the live preview source). */
  state(): FooterConfiguratorState {
    return {
      layout: this.draft as unknown as FooterLayoutV1,
      mode: this.mode,
      rowIndex: this.rowIndex,
      cursor: this.cursor,
      itemCursor: this.itemCursor,
      pickerIndex: this.pickerIndex,
      addQuery: this.addQuery,
      addSide: this.addSide,
      advancedField: this.advancedField,
      editing: this.editing,
      editBuffer: this.editBuffer,
    }
  }

  /** The registry ids NOT present in the draft layout (addable items —
   * builtin and extension items alike). */
  availableIds(): string[] {
    const present = new Set<string>()
    for (const row of this.draft.rows) {
      for (const ref of row.left) present.add(ref.id)
      for (const ref of row.right) present.add(ref.id)
    }
    return this.registry.ids().filter(id => !present.has(id))
  }

  /** The add picker's filtered matches: case-insensitive substring over
   * the item's label, id and description (an unknown id matches on its
   * raw id text). */
  addMatches(): string[] {
    const query = this.addQuery.trim().toLowerCase()
    const all = this.availableIds()
    if (query === '') return all
    return all.filter(id => {
      const def = this.registry.get(id)
      const haystack = [
        id,
        def?.label ?? '',
        def?.description ?? '',
      ].join('\n').toLowerCase()
      return haystack.includes(query)
    })
  }

  /** The edited row's mutable record (clamped). */
  private editedRow(): MutableRow {
    return this.draft.rows[Math.min(this.rowIndex, this.draft.rows.length - 1)]!
  }

  /** The ref at a flat position of the edited row. */
  private refAt(flat: number): { ref: MutableRef; pos: FlatPosition } | undefined {
    const row = this.editedRow()
    const pos = flatPositionOf(flat, row as unknown as FooterRowLayout)
    if (pos === undefined) return undefined
    const ref = pos.zone === 'left' ? row.left[pos.index]! : row.right[pos.index]!
    return { ref, pos }
  }

  /** Write a zone's refs back and clamp the flat cursor. */
  private setZoneRefs(zone: 'left' | 'right', refs: MutableRef[]): void {
    const row = this.editedRow()
    if (zone === 'left') row.left = refs
    else row.right = refs
    this.clampCursor()
  }

  private clampCursor(): void {
    const row = this.editedRow()
    this.cursor = Math.max(0, Math.min(this.cursor, row.left.length + row.right.length - 1))
  }

  /** ↑: selection up (reorder in Move Mode). */
  moveUp(): void {
    switch (this.mode) {
      case 'rows':
        this.rowIndex = Math.max(0, this.rowIndex - 1)
        return
      case 'row':
        this.cursor = Math.max(0, this.cursor - 1)
        return
      case 'row-move':
        this.reorderActive(-1)
        return
      case 'item':
        this.itemCursor = Math.max(0, this.itemCursor - 1)
        return
      case 'style':
        this.pickerIndex = Math.max(0, this.pickerIndex - 1)
        return
      case 'tone':
        this.pickerIndex = Math.max(0, this.pickerIndex - 1)
        return
      case 'advanced':
        if (!this.editing) this.advancedField = ADVANCED_FIELDS[Math.max(0, this.advancedFieldIndex() - 1)]!
        return
      case 'add':
        this.pickerIndex = Math.max(0, this.pickerIndex - 1)
        return
    }
  }

  /** ↓: selection down (reorder in Move Mode). */
  moveDown(): void {
    switch (this.mode) {
      case 'rows':
        this.rowIndex = Math.min(this.draft.rows.length - 1, this.rowIndex + 1)
        return
      case 'row':
        this.cursor = Math.min(Math.max(0, this.flatCount() - 1), this.cursor + 1)
        return
      case 'row-move':
        this.reorderActive(1)
        return
      case 'item':
        this.itemCursor = Math.min(itemMenuFor(this.itemFormats()).length - 1, this.itemCursor + 1)
        return
      case 'style': {
        const formats = this.itemFormats()
        this.pickerIndex = Math.min(Math.max(0, (formats?.length ?? 1) - 1), this.pickerIndex + 1)
        return
      }
      case 'tone':
        this.pickerIndex = Math.min(this.toneChoices().length - 1, this.pickerIndex + 1)
        return
      case 'advanced':
        if (!this.editing) {
          this.advancedField = ADVANCED_FIELDS[Math.min(ADVANCED_FIELDS.length - 1, this.advancedFieldIndex() + 1)]!
        }
        return
      case 'add':
        this.pickerIndex = Math.min(Math.max(0, this.addMatches().length - 1), this.pickerIndex + 1)
        return
    }
  }

  /** The edited row's item count (row page bounds). */
  private flatCount(): number {
    const row = this.editedRow()
    return row.left.length + row.right.length
  }

  /** The edited item's definition formats (undefined = unknown id). */
  private itemFormats(): readonly string[] | undefined {
    return this.registry.get(this.editedRefId())?.formats
  }

  /** The edited item's id (the flat cursor's ref; '' when the row is
   * empty). */
  private editedRefId(): string {
    return this.refAt(this.cursor)?.ref.id ?? ''
  }

  /** The advanced editor's selected field index. */
  private advancedFieldIndex(): number {
    return ADVANCED_FIELDS.indexOf(this.advancedField)
  }

  /** ←/→: move the item to that side (row pages); cycle the highlighted
   * setting inline (item page); no-op elsewhere. */
  moveZone(direction: 'left' | 'right'): void {
    if (this.mode === 'row' || this.mode === 'row-move') {
      const at = this.refAt(this.cursor)
      if (at === undefined || at.pos.zone === direction) return
      const row = this.editedRow()
      const from = at.pos.zone === 'left' ? [...row.left] : [...row.right]
      from.splice(at.pos.index, 1)
      const to = direction === 'left' ? [...row.left] : [...row.right]
      to.push(at.ref)
      if (at.pos.zone === 'left') {
        row.left = from
        row.right = to
      } else {
        row.right = from
        row.left = to
      }
      // The cursor follows the item to its appended position.
      this.cursor = direction === 'left'
        ? row.left.length - 1
        : row.left.length + row.right.length - 1
      return
    }
    if (this.mode === 'item') {
      this.cycleItemSetting(direction === 'left' ? -1 : 1)
    }
  }

  /** ←/→ on the item editor: cycle the highlighted setting's value.
   * Style cycles the finite formats; Tone cycles the tone choices;
   * Advanced opens the editor (nothing to cycle inline). */
  private cycleItemSetting(direction: -1 | 1): void {
    const menu = itemMenuFor(this.itemFormats())
    const entry = menu[Math.min(this.itemCursor, menu.length - 1)]
    if (entry === undefined) return
    const ref = this.refAt(this.cursor)?.ref
    if (ref === undefined) return
    if (entry.kind === 'style') {
      const def = this.registry.get(ref.id)!
      const current = ref.format ?? def.defaultFormat
      const index = def.formats.indexOf(current)
      const next = (index + direction + def.formats.length) % def.formats.length
      this.applyFormat(ref, def.formats[next]!, def)
      return
    }
    if (entry.kind === 'tone') {
      const current = ref.tone ?? 'auto'
      const choices = this.toneChoices()
      const index = choices.findIndex(choice => choice.value === current)
      const next = (index + direction + choices.length) % choices.length
      this.applyTone(ref, choices[next]!.value)
    }
  }

  /** The tone choices for the EDITED item's current tone (the 8
   * user-facing tones plus a legal-but-unlisted persisted token). The
   * draft's tone field is parser-validated in practice (the save gate
   * rejects unknown tokens); the cast only bridges the mutable draft's
   * string storage. */
  private toneChoices(): ReadonlyArray<{ readonly value: FooterTone | 'auto'; readonly label: string }> {
    return toneChoicesFor(this.refAt(this.cursor)?.ref?.tone as FooterTone | 'auto' | undefined)
  }

  /** Persist a format choice: the definition default removes the override
   * (the canonical round-trip — an explicit default never persists). */
  private applyFormat(ref: MutableRef, format: string, def: { readonly defaultFormat: string }): void {
    if (format === def.defaultFormat) delete ref.format
    else ref.format = format
  }

  /** Persist a tone choice: 'auto' removes the override. */
  private applyTone(ref: MutableRef, tone: FooterTone | 'auto'): void {
    if (tone === 'auto') delete ref.tone
    else ref.tone = tone
  }

  /** Reorder the cursor's item one position within its zone (Move Mode's
   * ↑↓, and the Edit Row page's legacy Shift+↑/↓ compat shortcut).
   * Zone-bounded — crossing zones is the ←/→ move. */
  reorderActive(direction: -1 | 1): void {
    const at = this.refAt(this.cursor)
    if (at === undefined) return
    const row = this.editedRow()
    const refs = at.pos.zone === 'left' ? [...row.left] : [...row.right]
    const target = at.pos.index + direction
    if (target < 0 || target >= refs.length) return
    const [ref] = refs.splice(at.pos.index, 1)
    refs.splice(target, 0, ref!)
    this.setZoneRefs(at.pos.zone, refs)
    this.cursor = at.pos.zone === 'left'
      ? target
      : row.left.length + target
  }

  /** Enter: the page's primary action. */
  activate(): void {
    switch (this.mode) {
      case 'rows':
        // Enter the highlighted row.
        this.rowIndex = Math.min(this.rowIndex, this.draft.rows.length - 1)
        this.mode = 'row'
        this.cursor = 0
        return
      case 'row':
        if (this.flatCount() > 0) {
          this.mode = 'item'
          this.itemCursor = 0
          this.pickerIndex = 0
        }
        return
      case 'row-move':
        this.mode = 'row'
        return
      case 'item': {
        const menu = itemMenuFor(this.itemFormats())
        const entry = menu[Math.min(this.itemCursor, menu.length - 1)]
        if (entry === undefined) return
        if (entry.kind === 'style') {
          this.mode = 'style'
          this.pickerIndex = this.currentFormatIndex()
        } else if (entry.kind === 'tone') {
          this.mode = 'tone'
          this.pickerIndex = this.currentToneIndex()
        } else {
          this.mode = 'advanced'
          this.advancedField = 'prefix'
          this.editing = false
          this.editBuffer = ''
        }
        return
      }
      case 'style': {
        const formats = this.itemFormats()
        const format = formats?.[Math.min(this.pickerIndex, formats.length - 1)]
        const ref = this.refAt(this.cursor)?.ref
        const def = ref === undefined ? undefined : this.registry.get(ref.id)
        if (format !== undefined && ref !== undefined && def !== undefined) this.applyFormat(ref, format, def)
        this.mode = 'item'
        return
      }
      case 'tone': {
        const choices = this.toneChoices()
        const choice = choices[Math.min(this.pickerIndex, choices.length - 1)]
        const ref = this.refAt(this.cursor)?.ref
        if (choice !== undefined && ref !== undefined) this.applyTone(ref, choice.value)
        this.mode = 'item'
        return
      }
      case 'advanced':
        if (this.editing) {
          this.commitEdit()
          return
        }
        if (this.advancedField === 'reset') {
          this.resetActiveRef()
          return
        }
        this.editing = true
        this.editBuffer = this.advancedFieldValue()
        return
      case 'add': {
        const matches = this.addMatches()
        const id = matches[Math.min(this.pickerIndex, matches.length - 1)]
        if (id === undefined) return
        const added = this.addAvailable(id, this.addSide)
        // ccstatusline parity: a SUCCESSFUL add closes the picker and
        // lands the cursor on the added item. A cap-refused add stays in
        // the picker (the '(row is full…)' notice explains why).
        if (added) this.mode = 'row'
        return
      }
    }
  }

  /** Esc: navigate back. Returns false exactly when the configurator
   * should CLOSE (Esc on the Row Selector). */
  cancel(): boolean {
    if (this.mode === 'advanced' && this.editing) {
      // First Esc inside an inline edit cancels the edit, not the page.
      this.editing = false
      this.editBuffer = ''
      return true
    }
    switch (this.mode) {
      case 'rows':
        return false
      case 'add':
        if (this.addQuery !== '') {
          // A search term swallows the first Esc: clear the search.
          this.addQuery = ''
          this.pickerIndex = 0
          return true
        }
        this.mode = 'row'
        return true
      case 'row':
        this.mode = 'rows'
        return true
      case 'row-move':
        // Move Mode's Esc exits the MODE back to the row editor (the
        // plan's A.4: Enter/Esc are both "Done" — never a page skip).
        this.mode = 'row'
        return true
      case 'item':
        this.mode = 'row'
        return true
      case 'style':
      case 'tone':
      case 'advanced':
        // The pickers hang off the ITEM EDITOR (row → item → picker):
        // Esc returns exactly one level up, matching the page hierarchy
        // and the help's "Esc Back".
        this.mode = 'item'
        return true
    }
  }

  /** A (Edit Row page): open the Add picker. The add side follows the
   * cursor's item zone (Left for an empty row — the C.5 default side
   * rule, applied to every item kind). */
  startAdd(): void {
    if (this.mode !== 'row') return
    const side = this.refAt(this.cursor)?.pos.zone ?? 'left'
    this.mode = 'add'
    this.addQuery = ''
    this.addSide = side
    this.pickerIndex = 0
  }

  /** M (Edit Row page): enter Move Mode. */
  startMove(): void {
    if (this.mode !== 'row' || this.flatCount() === 0) return
    this.mode = 'row-move'
  }

  /** Space (Edit Row page): remove the cursor's item (it returns to the
   * Add picker's pool — Available is derived, never stored). */
  removeActive(): void {
    if (this.mode !== 'row') return
    const at = this.refAt(this.cursor)
    if (at === undefined) return
    const row = this.editedRow()
    if (at.pos.zone === 'left') {
      row.left = row.left.filter(candidate => candidate !== at.ref)
    } else {
      row.right = row.right.filter(candidate => candidate !== at.ref)
    }
    this.clampCursor()
  }

  /** F (Edit Row page): cycle the item's finite format (the power-user
   * shortcut — the Style picker is the primary interaction). */
  cycleFormat(): void {
    if (this.mode !== 'row') return
    const at = this.refAt(this.cursor)
    if (at === undefined) return
    const def = this.registry.get(at.ref.id)
    if (def === undefined || def.formats.length <= 1) return
    const current = at.ref.format ?? def.defaultFormat
    const index = def.formats.indexOf(current)
    const next = def.formats[(index + 1) % def.formats.length]!
    this.applyFormat(at.ref, next, def)
  }

  /** Add one available item to a side of the edited row (appended at the
   * end; the cursor lands on it). Returns false — with NO mutation —
   * when the edited row is already at the parser's per-row item cap: a
   * 33rd item would make every future save fail to parse. */
  addAvailable(id: string, zone: 'left' | 'right'): boolean {
    const row = this.editedRow()
    if (row.left.length + row.right.length >= MAX_ITEMS_PER_ROW) return false
    const ref: MutableRef = { id }
    if (zone === 'left') row.left = [...row.left, ref]
    else row.right = [...row.right, ref]
    this.cursor = zone === 'left'
      ? row.left.length - 1
      : row.left.length + row.right.length - 1
    return true
  }

  /** The style picker's index of the item's current format (the picker
   * opens on the current choice). */
  private currentFormatIndex(): number {
    const formats = this.itemFormats()
    if (formats === undefined || formats.length === 0) return 0
    const ref = this.refAt(this.cursor)?.ref
    const current = ref === undefined ? undefined : ref.format ?? this.registry.get(ref.id)?.defaultFormat
    const index = current === undefined ? -1 : formats.indexOf(current)
    return index < 0 ? 0 : index
  }

  /** The tone picker's index of the item's current tone (an unlisted
   * persisted token resolves to its appended row — never fake-'Auto'). */
  private currentToneIndex(): number {
    const ref = this.refAt(this.cursor)?.ref
    const current = ref === undefined || ref.tone === undefined ? 'auto' : ref.tone
    const choices = this.toneChoices()
    const index = choices.findIndex(choice => choice.value === current)
    return index < 0 ? 0 : index
  }

  /** Printable text: the add picker's query or the advanced inline
   * editor's buffer. Everything else ignores it. */
  text(data: string): void {
    const clean = stripControlChars(data)
    if (clean === '') return
    if (this.mode === 'add') {
      this.addQuery = (this.addQuery + clean).slice(0, 64)
      this.pickerIndex = 0
      return
    }
    if (this.mode === 'advanced' && this.editing) {
      if (this.advancedField === 'importance') {
        // Importance is a non-negative integer (the parser's 0..1000
        // bound): digits only.
        this.editBuffer = (this.editBuffer + clean.replace(/[^0-9]/g, '')).slice(0, 4)
        return
      }
      this.editBuffer = (this.editBuffer + clean).slice(0, MAX_PREFIX_SUFFIX_LENGTH)
    }
  }

  /** Backspace: delete the last character of the active text input. */
  backspace(): void {
    if (this.mode === 'add') {
      this.addQuery = this.addQuery.slice(0, -1)
      this.pickerIndex = 0
      return
    }
    if (this.mode === 'advanced' && this.editing) {
      this.editBuffer = this.editBuffer.slice(0, -1)
    }
  }

  /** The advanced field's current value (the inline editor's seed). The
   * seed is STRIPPED: the buffer must never carry control characters
   * from a hand-built ref's prefix/suffix. */
  private advancedFieldValue(): string {
    const ref = this.refAt(this.cursor)?.ref
    if (ref === undefined) return ''
    switch (this.advancedField) {
      case 'prefix': return stripControlChars(ref.prefix ?? '')
      case 'suffix': return stripControlChars(ref.suffix ?? '')
      case 'importance': return ref.importance === undefined ? '' : String(ref.importance)
      case 'reset': return ''
    }
  }

  /** Commit the advanced inline edit (Enter while editing). An empty
   * buffer removes the override; an out-of-range importance cancels the
   * edit without applying. */
  private commitEdit(): void {
    const at = this.refAt(this.cursor)
    this.editing = false
    if (at === undefined) {
      this.editBuffer = ''
      return
    }
    const ref = at.ref
    if (this.advancedField === 'prefix') {
      if (this.editBuffer === '') delete ref.prefix
      else ref.prefix = this.editBuffer
    } else if (this.advancedField === 'suffix') {
      if (this.editBuffer === '') delete ref.suffix
      else ref.suffix = this.editBuffer
    } else if (this.advancedField === 'importance') {
      if (this.editBuffer === '') {
        delete ref.importance
      } else {
        const value = Number(this.editBuffer)
        if (!Number.isFinite(value) || value < 0 || value > MAX_IMPORTANCE) {
          this.editBuffer = ''
          return
        }
        ref.importance = value
      }
    }
    this.editBuffer = ''
  }

  /** Reset the edited ref to the definition defaults (the Advanced
   * editor's "Reset to default"). */
  resetActiveRef(): void {
    const ref = this.refAt(this.cursor)?.ref
    if (ref === undefined) return
    delete ref.format
    delete ref.tone
    delete ref.prefix
    delete ref.suffix
    delete ref.importance
  }

  /** The draft layout (the live preview source). */
  preview(): FooterLayoutV1 {
    return this.draft as unknown as FooterLayoutV1
  }

  /** Re-anchor the editor onto the Row Selector after a whole-layout
   * replacement (preset reset, row removal): the draft's item identities
   * changed, so EVERY page cursor, picker, query and inline-edit buffer
   * is cleared — a stale advanced buffer must never be committed into an
   * item of the new layout. */
  private reanchor(): void {
    this.mode = 'rows'
    this.rowIndex = 0
    this.cursor = 0
    this.itemCursor = 0
    this.pickerIndex = 0
    this.addQuery = ''
    this.addSide = 'left'
    this.advancedField = 'prefix'
    this.editing = false
    this.editBuffer = ''
  }

  /** Reset the draft to the builtin default layout. */
  resetDefault(): void {
    const next = cloneLayout(DEFAULT_FOOTER_LAYOUT)
    this.draft.rows = next.rows
    this.reanchor()
  }

  /** Reset the draft to the builtin compact layout. */
  resetCompact(): void {
    const next = cloneLayout(COMPACT_FOOTER_LAYOUT)
    this.draft.rows = next.rows
    this.reanchor()
  }

  /** Add a second row (1..2 rows). */
  addRow(): void {
    if (this.draft.rows.length >= 2) return
    this.draft.rows = [...this.draft.rows, { left: [], right: [] }]
  }

  /** Remove the last row (1..2 rows). The edited row's identity can
   * vanish with it: re-anchor onto the Row Selector. */
  removeRow(): void {
    if (this.draft.rows.length <= 1) return
    this.draft.rows = this.draft.rows.slice(0, -1)
    this.reanchor()
  }
}

/** The advanced editor's field order (Reset last). */
const ADVANCED_FIELDS: readonly FooterAdvancedField[] = ['prefix', 'suffix', 'importance', 'reset']