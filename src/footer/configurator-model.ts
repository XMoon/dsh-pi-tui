/**
 * The footer configurator MODEL (the hierarchical editor): a pure state
 * machine over a draft FooterLayoutV1 organized as PAGES —
 *
 *   rows (Row Selector) → row (Edit Row) → item (Item Editor)
 *                                          ├─ style (Style picker)
 *                                          ├─ tone  (Tone picker)
 *                                          ├─ custom Text/Tone
 *                                          ├─ Advanced (Prefix/Suffix/
 *                                          │            Importance/Reset)
 *                                          └─ Rename/Delete definition
 *   row → add (searchable Add picker → Create Custom Text flow)
 *   row ⇄ row-move (Move Mode)
 *   rows → exit-confirm (dirty-Esc: Save & Exit / Discard & Exit / Keep
 *          Editing — PR E; plus the trailing "Save changes" home action)
 *
 * The UI component only renders and forwards keys; the whole model is
 * headless-testable. The persisted shape (FooterLayoutV1 / FooterItemRef)
 * is untouched: `format` is the only style field, `tone` the only tone
 * field, and unknown/throwing definitions degrade to inert rows.
 * @module @xmoon76/dsh-pi-tui/footer/configurator-model
 */

import {
  DEFAULT_CUSTOM_COMMAND_REFRESH_MS,
  FooterCustomItemCatalog,
  type FooterCustomItemSettings,
  customItemId,
  customItemName,
  effectiveCustomCommandRefreshMs,
  effectiveCustomCommandTimeoutMs,
} from './custom-items.ts'
import { DEFAULT_COMMAND_TIMEOUT_MS } from './command-runner.ts'
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
  | 'create-name'
  | 'create-text'
  | 'create-command'
  | 'create-refresh'
  | 'create-timeout'
  | 'create-tone'
  | 'custom-text'
  | 'custom-command'
  | 'custom-refresh'
  | 'custom-timeout'
  | 'custom-tone'
  | 'custom-name'
  | 'custom-delete'
  /** PR E: the dirty-Esc confirmation page (a MODEL mode, never a second
   * overlay — input focus, resize and the Esc hierarchy stay trivial). */
  | 'exit-confirm'

/** The Row Selector's semantic selection (PR E §4.2): the cursor's range is
 * `0..rows.length` — every row index selects that row, and the trailing
 * entry is the Save action. `rowIndex` itself NEVER carries the sentinel:
 * it keeps meaning "the row being edited". */
export type FooterHomeSelection =
  | { readonly kind: 'row'; readonly rowIndex: number }
  | { readonly kind: 'save' }

/** The exit-confirm page's actions (PR E §7.2). */
export type FooterExitChoice = 'save' | 'discard' | 'keep'

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
  /** The name currently being created (without the persisted `user:` prefix). */
  readonly customName: string
  /** The text currently being created. */
  readonly customText: string
  /** The kind of the custom item being created (the Add picker's two
   * create actions: Custom Text / Custom Command). */
  readonly customKind: 'text' | 'command'
  /** The command currently being created. */
  readonly customCommand: string
  /** The refresh interval (ms) currently being created. */
  readonly customRefresh: number
  /** The timeout (ms) currently being created. */
  readonly customTimeout: number
  /** The tone currently being created. */
  readonly customTone: FooterTone | 'auto'
  /** A fail-soft validation message for the current custom-item flow. */
  readonly customError: string
  /** The Row Selector's cursor: `0..rows.length-1` are the rows,
   * `rows.length` is the Save changes action (PR E §4). */
  readonly homeCursor: number
  /** The exit-confirm page's selected action (0 Save & Exit, 1 Discard &
   * Exit, 2 Keep Editing). */
  readonly exitConfirmCursor: number
  /** Whether a save is currently in flight (PR E §10): duplicate saves
   * are refused and the page shows Saving…. */
  readonly saving: boolean
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

/** Dirty comparison treats the ABSENT override and the explicit 'auto'
 * token as the same fact (the model itself only ever deletes the field on
 * 'auto' — PR E §5.4's normalized snapshot, not raw JSON equality). */
function normalizeToneForCompare(tone: string | undefined): string | undefined {
  return tone === undefined || tone === 'auto' ? undefined : tone
}

function sameFooterRef(a: FooterItemRef, b: FooterItemRef): boolean {
  return a.id === b.id
    && (a.format ?? undefined) === (b.format ?? undefined)
    && normalizeToneForCompare(a.tone) === normalizeToneForCompare(b.tone)
    && (a.prefix ?? undefined) === (b.prefix ?? undefined)
    && (a.suffix ?? undefined) === (b.suffix ?? undefined)
    && (a.importance ?? undefined) === (b.importance ?? undefined)
}

function sameFooterRow(a: FooterRowLayout, b: FooterRowLayout): boolean {
  if (a.left.length !== b.left.length || a.right.length !== b.right.length) return false
  for (let index = 0; index < a.left.length; index += 1) {
    if (!sameFooterRef(a.left[index]!, b.left[index]!)) return false
  }
  for (let index = 0; index < a.right.length; index += 1) {
    if (!sameFooterRef(a.right[index]!, b.right[index]!)) return false
  }
  if (a.separator === undefined || b.separator === undefined) return a.separator === b.separator
  return a.separator.text === b.separator.text
    && normalizeToneForCompare(a.separator.tone) === normalizeToneForCompare(b.separator.tone)
}

/** Structural layout equality (row count, item order, every editable ref
 * field, separators). Field order in the underlying objects is irrelevant
 * by construction — no JSON stringify round-trip. Context-free BY DESIGN:
 * dirty detection projects both sides through canonicalLayout first. */
export function sameFooterLayout(a: FooterLayoutV1, b: FooterLayoutV1): boolean {
  if (a.rows.length !== b.rows.length) return false
  return a.rows.every((row, index) => sameFooterRow(row, b.rows[index]!))
}

/** Structural definition equality (PR D §13.1): a discriminated switch per
 * kind. Command definitions compare their EFFECTIVE refresh/timeout (an
 * absent default and an explicit default are the same fact — a no-op
 * editor round-trip must never read as dirty). Exported so the
 * configurator's draft value source can gate a committed command cache on
 * definition equality. */
export function sameFooterCustomItem(
  a: FooterCustomItemSettings,
  b: FooterCustomItemSettings,
): boolean {
  if (a.schemaVersion !== b.schemaVersion || a.id !== b.id || a.kind !== b.kind) return false
  if (a.kind === 'text' && b.kind === 'text') {
    return a.text === b.text
      && normalizeToneForCompare(a.tone) === normalizeToneForCompare(b.tone)
  }
  if (a.kind === 'command' && b.kind === 'command') {
    return a.command === b.command
      && effectiveCustomCommandRefreshMs(a) === effectiveCustomCommandRefreshMs(b)
      && effectiveCustomCommandTimeoutMs(a) === effectiveCustomCommandTimeoutMs(b)
      && normalizeToneForCompare(a.tone) === normalizeToneForCompare(b.tone)
  }
  return false
}

/** Structural definition-catalog equality in PERSISTED ORDER (the order is
 * part of the saved document — PR E §5.3). Covers create / text / tone /
 * rename / delete: every mutation of the catalog changes this result. */
export function sameFooterCustomItems(
  a: readonly FooterCustomItemSettings[],
  b: readonly FooterCustomItemSettings[],
): boolean {
  if (a.length !== b.length) return false
  return a.every((item, index) => sameFooterCustomItem(item, b[index]!))
}

/** Resolves an item id to its definition's default format (undefined for
 * an unknown id — its formats are unknowable, so an explicit format is
 * always a real override there). */
type FooterDefaultFormatOf = (id: string) => string | undefined

/** The canonical REF projection the dirty comparison uses (PR E review):
 * facts the editor itself canonicalizes on the next interaction compare
 * EQUAL to their absent form —
 *   tone 'auto'          → absent
 *   format = default     → absent (registry-aware)
 *   prefix ''/suffix ''  → absent
 * A no-op Style Enter (Enter on the already-selected default) or a no-op
 * Advanced commit (empty buffer) must therefore never read as dirty. */
function canonicalRef(ref: FooterItemRef, defaultFormatOf: FooterDefaultFormatOf): FooterItemRef {
  const tone = normalizeToneForCompare(ref.tone)
  return {
    id: ref.id,
    ...(ref.format !== undefined && ref.format !== defaultFormatOf(ref.id) ? { format: ref.format } : {}),
    ...(tone === undefined ? {} : { tone: tone as FooterTone }),
    ...(ref.prefix === undefined || ref.prefix === '' ? {} : { prefix: ref.prefix }),
    ...(ref.suffix === undefined || ref.suffix === '' ? {} : { suffix: ref.suffix }),
    ...(ref.importance === undefined ? {} : { importance: ref.importance }),
  }
}

/** Canonical LAYOUT projection: row/zone ORDER and separators preserved,
 * every ref projected through canonicalRef. Both sides of the dirty
 * comparison are projected with the SAME (current) registry, so a
 * definition change mid-session shifts both views identically. */
function canonicalLayout(layout: FooterLayoutV1, defaultFormatOf: FooterDefaultFormatOf): FooterLayoutV1 {
  return {
    schemaVersion: 1,
    rows: layout.rows.map(row => ({
      left: row.left.map(ref => canonicalRef(ref, defaultFormatOf)),
      right: row.right.map(ref => canonicalRef(ref, defaultFormatOf)),
      ...(row.separator === undefined ? {} : { separator: { ...row.separator } }),
    })),
  }
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
 * than one finite format — a single format has nothing to pick). Custom
 * definitions expose their definition-owned controls (text/command,
 * refresh/timeout, default tone) and name/delete actions alongside the
 * shared placement-tone and Advanced controls. */
export type ItemMenuEntry =
  | { readonly kind: 'style' }
  | { readonly kind: 'tone' }
  | { readonly kind: 'advanced' }
  | { readonly kind: 'custom-text' }
  | { readonly kind: 'custom-command' }
  | { readonly kind: 'custom-refresh' }
  | { readonly kind: 'custom-timeout' }
  | { readonly kind: 'custom-tone' }
  | { readonly kind: 'custom-name' }
  | { readonly kind: 'custom-delete' }

/** The refresh-interval choices for a custom command item (PR D §13.3):
 * the picker's finite set, in ms. */
export const CUSTOM_COMMAND_REFRESH_CHOICES_MS: readonly number[] = [1000, 5000, 10000, 30000, 60000]
/** The timeout choices for a custom command item, in ms. */
export const CUSTOM_COMMAND_TIMEOUT_CHOICES_MS: readonly number[] = [100, 300, 500, 1000]

/** The refresh choices for one item's CURRENT effective refresh: the
 * finite set, plus — when the definition carries a legal but UNLISTED
 * persisted value — that exact value, so a hand-edited refresh is never
 * displayed as the nearest choice and never silently replaced by a
 * fake-pick apply. */
export function customCommandRefreshChoices(current: number): readonly number[] {
  return CUSTOM_COMMAND_REFRESH_CHOICES_MS.includes(current)
    ? CUSTOM_COMMAND_REFRESH_CHOICES_MS
    : [...CUSTOM_COMMAND_REFRESH_CHOICES_MS, current]
}

/** The timeout choices for one item's CURRENT effective timeout (same
 * unlisted-value rule as the refresh choices). */
export function customCommandTimeoutChoices(current: number): readonly number[] {
  return CUSTOM_COMMAND_TIMEOUT_CHOICES_MS.includes(current)
    ? CUSTOM_COMMAND_TIMEOUT_CHOICES_MS
    : [...CUSTOM_COMMAND_TIMEOUT_CHOICES_MS, current]
}

/** The item editor's menu for one definition (undefined = an unknown id:
 * its format set is unknowable, so Style is hidden). `custom` names the
 * definition kind when the edited ref is a user-owned definition. */
export function itemMenuFor(
  formats: readonly string[] | undefined,
  custom: 'text' | 'command' | undefined,
): ItemMenuEntry[] {
  const entries: ItemMenuEntry[] = []
  if (formats !== undefined && formats.length > 1) entries.push({ kind: 'style' })
  if (custom === 'text') {
    entries.push({ kind: 'custom-text' })
    entries.push({ kind: 'custom-tone' })
  } else if (custom === 'command') {
    entries.push({ kind: 'custom-command' })
    entries.push({ kind: 'custom-refresh' })
    entries.push({ kind: 'custom-timeout' })
    entries.push({ kind: 'custom-tone' })
  }
  entries.push({ kind: 'tone' })
  entries.push({ kind: 'advanced' })
  if (custom !== undefined) {
    entries.push({ kind: 'custom-name' })
    entries.push({ kind: 'custom-delete' })
  }
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
  private customName = ''
  private customText = ''
  private customKind: 'text' | 'command' = 'text'
  private customCommand = ''
  private customRefresh = DEFAULT_CUSTOM_COMMAND_REFRESH_MS
  private customTimeout = DEFAULT_COMMAND_TIMEOUT_MS
  private customTone: FooterTone | 'auto' = 'auto'
  private customError = ''
  /** The Row Selector's cursor (Row N, or the trailing Save action). */
  private homeCursor = 0
  /** The exit-confirm page's selected action. */
  private exitConfirmCursor = 0
  /** True while a save promise is in flight (PR E §10). */
  private saving = false
  /** The detached save baseline (PR E §5.2): captured at construction,
   * never mutated afterwards — draft mutations cannot reach it. */
  private readonly baselineLayout: MutableLayout
  private readonly baselineCustomItems: readonly FooterCustomItemSettings[]
  private readonly registry: FooterItemRegistry
  private readonly customItems: FooterCustomItemCatalog

  constructor(initial: FooterLayoutV1, registry: FooterItemRegistry, customItems?: FooterCustomItemCatalog) {
    // A parser-valid layout always has 1..2 rows, but the model accepts
    // any FooterLayoutV1 (hand-built test layouts, foreign callers): a
    // zero-row draft would make editedRow() return undefined and crash
    // the first page transition. Normalize to ONE empty row — every
    // subsequent invariant (editedRow, clamps, the row-page rendering)
    // can then rely on rows.length >= 1.
    this.draft = cloneLayout(initial.rows.length === 0
      ? { schemaVersion: 1, rows: [{ left: [], right: [] }] }
      : initial)
    // The baseline mirrors the NORMALIZED draft (a zero-row initial must
    // not read as dirty on open) and is double-detached: the catalog
    // snapshot already copies, but the baseline must survive even a
    // future snapshot change (PR E §5.2).
    this.baselineLayout = cloneLayout(this.draft as unknown as FooterLayoutV1)
    this.registry = registry
    this.customItems = customItems ?? new FooterCustomItemCatalog()
    this.baselineCustomItems = this.customItems.snapshot().map(item => ({ ...item }))
    // A caller that supplies a draft catalog expects the editor's picker and
    // preview to see it through the same registry. Do not replace an existing
    // app source when no draft catalog was requested (legacy callers use the
    // app registry directly).
    if (customItems !== undefined) registry.setCustomSource(customItems)
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
      customName: this.customName,
      customText: this.customText,
      customKind: this.customKind,
      customCommand: this.customCommand,
      customRefresh: this.customRefresh,
      customTimeout: this.customTimeout,
      customTone: this.customTone,
      customError: this.customError,
      homeCursor: this.homeCursor,
      exitConfirmCursor: this.exitConfirmCursor,
      saving: this.saving,
    }
  }

  /** The registry's DEFINITION CATALOG (the Add picker's addable items —
   * builtin and extension items alike). A definition may be PLACED any
   * number of times: adding an already-placed id appends an independent
   * placement (its own format/tone/prefix/suffix/importance), so the
   * catalog is never filtered by what the draft layout already uses. */
  availableIds(): string[] {
    return this.registry.ids()
  }

  /** Detached custom definitions in their persisted order. */
  customItemSettings(): FooterCustomItemSettings[] {
    return this.customItems.snapshot()
  }

  /** Structured dirty detection (PR E §5): the draft LAYOUT and the draft
   * DEFINITION CATALOG are each compared against the construction
   * baseline. Reversible by contract — every mutation that returns the
   * draft to the baseline state (reorder + reorder back, tone + tone
   * back, create + delete) returns to clean.
   *
   * Registry-aware canonicalization (review round 3): BOTH sides are
   * projected through canonicalLayout with the CURRENT registry before
   * comparison, so facts the editor canonicalizes anyway — an explicit
   * 'auto' tone, a format equal to the definition's default, empty-string
   * prefix/suffix — never read as dirty. The exported sameFooterLayout
   * stays a pure comparator; this layer owns the projection. */
  isDirty(): boolean {
    const defaultFormatOf: FooterDefaultFormatOf = id => this.registry.get(id)?.defaultFormat
    const layoutDirty = !sameFooterLayout(
      canonicalLayout(this.draft as unknown as FooterLayoutV1, defaultFormatOf),
      canonicalLayout(this.baselineLayout as unknown as FooterLayoutV1, defaultFormatOf),
    )
    const itemsDirty = !sameFooterCustomItems(this.customItems.snapshot(), this.baselineCustomItems)
    return layoutDirty || itemsDirty
  }

  /** Enter the saving state (PR E §10): the panel refuses duplicate save
   * requests and Esc-close while a save promise is in flight. */
  beginSave(): void {
    this.saving = true
  }

  /** Clear the saving state after a FAILED save (success closes the whole
   * configurator — there is nothing left to reset). */
  endSave(): void {
    this.saving = false
  }

  /** The Row Selector's semantic selection (PR E §4.2): rows map to their
   * index; the trailing entry is the Save action. */
  homeSelection(): FooterHomeSelection {
    if (this.homeCursor >= this.draft.rows.length) return { kind: 'save' }
    return { kind: 'row', rowIndex: this.homeCursor }
  }

  /** Enter on the exit-confirm page (PR E §7.2). 'keep' re-enters the Row
   * Selector immediately; 'save' and 'discard' keep the mode — the PANEL
   * performs them (async save path / close-without-write), and what the
   * user sees next is decided by the save's outcome, not by this method. */
  exitConfirmAction(): FooterExitChoice {
    if (this.mode !== 'exit-confirm') return 'keep'
    if (this.exitConfirmCursor === 0) return 'save'
    if (this.exitConfirmCursor === 1) return 'discard'
    this.mode = 'rows'
    this.exitConfirmCursor = 0
    return 'keep'
  }

  /** Whether an id is one of this editor's user-owned definitions. */
  isCustomItem(id: string): boolean {
    return this.customItems.has(id)
  }

  /** The current user-owned definition for an item ref. */
  customItem(id: string): FooterCustomItemSettings | undefined {
    return this.customItems.get(id)
  }

  /** The add picker's filtered matches: case-insensitive substring over
   * the item's label, id, description, and user-defined text (an unknown id
   * matches on its raw id text). */
  addMatches(): string[] {
    const query = this.addQuery.trim().toLowerCase()
    const all = this.availableIds()
    if (query === '') return all
    return all.filter(id => {
      const def = this.registry.get(id)
      const custom = this.customItems.get(id)
      const haystack = [
        id,
        def?.label ?? '',
        def?.description ?? '',
        custom?.kind === 'text' ? custom.text : '',
        custom?.kind === 'command' ? custom.command : '',
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
        this.homeCursor = Math.max(0, this.homeCursor - 1)
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
      case 'tone':
      case 'custom-tone':
      case 'custom-refresh':
      case 'custom-timeout':
        this.pickerIndex = Math.max(0, this.pickerIndex - 1)
        return
      case 'create-tone':
        this.pickerIndex = Math.max(0, this.pickerIndex - 1)
        this.customTone = FOOTER_TONE_CHOICES[this.pickerIndex]?.value ?? 'auto'
        return
      case 'create-refresh':
      case 'create-timeout':
        this.pickerIndex = Math.max(0, this.pickerIndex - 1)
        return
      case 'advanced':
        if (!this.editing) this.advancedField = ADVANCED_FIELDS[Math.max(0, this.advancedFieldIndex() - 1)]!
        return
      case 'add':
        this.pickerIndex = Math.max(0, this.pickerIndex - 1)
        return
      case 'exit-confirm':
        this.exitConfirmCursor = Math.max(0, this.exitConfirmCursor - 1)
        return
    }
  }

  /** ↓: selection down (reorder in Move Mode). */
  moveDown(): void {
    switch (this.mode) {
      case 'rows':
        // One past the last row sits the Save changes action (PR E §4).
        this.homeCursor = Math.min(this.draft.rows.length, this.homeCursor + 1)
        return
      case 'row':
        this.cursor = Math.min(Math.max(0, this.flatCount() - 1), this.cursor + 1)
        return
      case 'row-move':
        this.reorderActive(1)
        return
      case 'item':
        this.itemCursor = Math.min(this.itemMenu().length - 1, this.itemCursor + 1)
        return
      case 'style': {
        const formats = this.itemFormats()
        this.pickerIndex = Math.min(Math.max(0, (formats?.length ?? 1) - 1), this.pickerIndex + 1)
        return
      }
      case 'tone':
        this.pickerIndex = Math.min(this.toneChoices().length - 1, this.pickerIndex + 1)
        return
      case 'custom-tone':
        this.pickerIndex = Math.min(this.customToneChoices().length - 1, this.pickerIndex + 1)
        return
      case 'custom-refresh':
        this.pickerIndex = Math.min(this.customRefreshChoices().length - 1, this.pickerIndex + 1)
        return
      case 'custom-timeout':
        this.pickerIndex = Math.min(this.customTimeoutChoices().length - 1, this.pickerIndex + 1)
        return
      case 'create-tone':
        this.pickerIndex = Math.min(FOOTER_TONE_CHOICES.length - 1, this.pickerIndex + 1)
        this.customTone = FOOTER_TONE_CHOICES[this.pickerIndex]?.value ?? 'auto'
        return
      case 'create-refresh':
        this.pickerIndex = Math.min(CUSTOM_COMMAND_REFRESH_CHOICES_MS.length - 1, this.pickerIndex + 1)
        return
      case 'create-timeout':
        this.pickerIndex = Math.min(CUSTOM_COMMAND_TIMEOUT_CHOICES_MS.length - 1, this.pickerIndex + 1)
        return
      case 'advanced':
        if (!this.editing) {
          this.advancedField = ADVANCED_FIELDS[Math.min(ADVANCED_FIELDS.length - 1, this.advancedFieldIndex() + 1)]!
        }
        return
      case 'add':
        this.pickerIndex = Math.min(this.addMatches().length + 1, this.pickerIndex + 1)
        return
      case 'exit-confirm':
        this.exitConfirmCursor = Math.min(2, this.exitConfirmCursor + 1)
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

  private editedCustomItem(): FooterCustomItemSettings | undefined {
    return this.customItems.get(this.editedRefId())
  }

  private itemMenu(): ItemMenuEntry[] {
    return itemMenuFor(this.itemFormats(), this.editedCustomItem()?.kind)
  }

  private customToneChoices(): ReadonlyArray<{ readonly value: FooterTone | 'auto'; readonly label: string }> {
    return toneChoicesFor(this.editedCustomItem()?.tone ?? 'auto')
  }

  /** The refresh choices for the EDITED command item's current effective
   * refresh (the finite set plus a legal-but-unlisted persisted value). */
  private customRefreshChoices(): readonly number[] {
    const item = this.editedCustomItem()
    const current = item?.kind === 'command'
      ? effectiveCustomCommandRefreshMs(item)
      : DEFAULT_CUSTOM_COMMAND_REFRESH_MS
    return customCommandRefreshChoices(current)
  }

  /** The timeout choices for the EDITED command item's current effective
   * timeout. */
  private customTimeoutChoices(): readonly number[] {
    const item = this.editedCustomItem()
    const current = item?.kind === 'command'
      ? effectiveCustomCommandTimeoutMs(item)
      : DEFAULT_COMMAND_TIMEOUT_MS
    return customCommandTimeoutChoices(current)
  }

  /** The add picker has two non-item actions after its filtered matches
   * (Create Custom Text / Create Custom Command). */
  addOptionCount(): number {
    return this.addMatches().length + 2
  }

  /** True when the highlighted add option is a create action. */
  isCreateOption(): boolean {
    return this.mode === 'add' && this.pickerIndex >= this.addMatches().length
  }

  /** The create action the add picker's cursor highlights (undefined when
   * the cursor is on a real item). */
  createActionKind(): 'text' | 'command' | undefined {
    if (this.mode !== 'add') return undefined
    const offset = this.pickerIndex - this.addMatches().length
    if (offset === 0) return 'text'
    if (offset === 1) return 'command'
    return undefined
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
    const menu = this.itemMenu()
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
      return
    }
    if (entry.kind === 'custom-tone') {
      const current = this.editedCustomItem()?.tone ?? 'auto'
      const choices = this.customToneChoices()
      const index = choices.findIndex(choice => choice.value === current)
      const next = (index + direction + choices.length) % choices.length
      this.applyCustomTone(choices[next]!.value)
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

  /** Persist a custom definition's tone in the draft catalog. */
  private applyCustomTone(tone: FooterTone | 'auto'): void {
    const id = this.editedRefId()
    const result = this.customItems.updateTone(id, tone)
    if (!result.ok) this.customError = result.error ?? 'The selected tone is invalid.'
    else this.customError = ''
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
      case 'rows': {
        // Enter opens the SELECTED ROW. The Save action (the trailing
        // home entry) is deliberately NOT handled here: persistence is
        // async and therefore panel business (PR E §14) — the panel
        // routes that Enter to its single save path before activating.
        const selection = this.homeSelection()
        if (selection.kind === 'save') return
        this.rowIndex = selection.rowIndex
        this.mode = 'row'
        this.cursor = 0
        return
      }
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
        const menu = this.itemMenu()
        const entry = menu[Math.min(this.itemCursor, menu.length - 1)]
        if (entry === undefined) return
        if (entry.kind === 'style') {
          this.mode = 'style'
          this.pickerIndex = this.currentFormatIndex()
        } else if (entry.kind === 'tone') {
          this.mode = 'tone'
          this.pickerIndex = this.currentToneIndex()
        } else if (entry.kind === 'custom-text') {
          const item = this.editedCustomItem()
          if (item === undefined || item.kind !== 'text') return
          this.mode = 'custom-text'
          this.editing = true
          this.editBuffer = item.text
          this.customError = ''
        } else if (entry.kind === 'custom-command') {
          const item = this.editedCustomItem()
          if (item === undefined || item.kind !== 'command') return
          this.mode = 'custom-command'
          this.editing = true
          this.editBuffer = item.command
          this.customError = ''
        } else if (entry.kind === 'custom-refresh') {
          this.mode = 'custom-refresh'
          this.pickerIndex = this.currentCustomRefreshIndex()
          this.customError = ''
        } else if (entry.kind === 'custom-timeout') {
          this.mode = 'custom-timeout'
          this.pickerIndex = this.currentCustomTimeoutIndex()
          this.customError = ''
        } else if (entry.kind === 'custom-tone') {
          this.mode = 'custom-tone'
          this.pickerIndex = this.currentCustomToneIndex()
          this.customError = ''
        } else if (entry.kind === 'custom-name') {
          const item = this.editedCustomItem()
          if (item === undefined) return
          this.mode = 'custom-name'
          this.editing = true
          this.editBuffer = customItemName(item.id)
          this.customError = ''
        } else if (entry.kind === 'custom-delete') {
          this.mode = 'custom-delete'
          this.customError = ''
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
      case 'custom-tone': {
        const choices = this.customToneChoices()
        const choice = choices[Math.min(this.pickerIndex, choices.length - 1)]
        if (choice !== undefined) this.applyCustomTone(choice.value)
        this.mode = 'item'
        return
      }
      case 'custom-refresh': {
        const choices = this.customRefreshChoices()
        const choice = choices[Math.min(this.pickerIndex, choices.length - 1)]
        if (choice !== undefined) this.applyCustomRefresh(choice)
        this.mode = 'item'
        return
      }
      case 'custom-timeout': {
        const choices = this.customTimeoutChoices()
        const choice = choices[Math.min(this.pickerIndex, choices.length - 1)]
        if (choice !== undefined) this.applyCustomTimeout(choice)
        this.mode = 'item'
        return
      }
      case 'custom-text':
        if (this.editing) {
          this.commitCustomText()
          return
        }
        this.mode = 'item'
        return
      case 'custom-command':
        if (this.editing) {
          this.commitCustomCommand()
          return
        }
        this.mode = 'item'
        return
      case 'custom-name':
        if (this.editing) {
          this.commitCustomName()
          return
        }
        this.mode = 'item'
        return
      case 'custom-delete': {
        const id = this.editedRefId()
        if (!this.customItems.remove(id)) {
          this.customError = 'Footer item no longer exists.'
          this.mode = 'item'
          return
        }
        this.removeReferences(id)
        this.mode = 'row'
        this.itemCursor = 0
        this.clampCursor()
        return
      }
      case 'create-name': {
        const name = this.customName.trim()
        const id = customItemId(name)
        if (id === undefined) {
          this.customError = name === ''
            ? 'Name is required.'
            : 'Name must be visible, at most 64 characters, and contain no colon.'
          return
        }
        if (this.customItems.has(id) || this.registry.ids().includes(id)) {
          this.customError = `A footer item named "${name}" already exists.`
          return
        }
        this.customError = ''
        this.mode = this.customKind === 'command' ? 'create-command' : 'create-text'
        return
      }
      case 'create-text':
        if (this.customText.trim() === '') {
          this.customError = 'Text is required.'
          return
        }
        this.customError = ''
        this.mode = 'create-tone'
        this.pickerIndex = 0
        return
      case 'create-command':
        if (this.customCommand.trim() === '') {
          this.customError = 'Command is required.'
          return
        }
        this.customError = ''
        this.mode = 'create-refresh'
        // The picker opens on the DEFAULT refresh (5s), not the first
        // choice — an unchanged Enter creates the documented default.
        this.pickerIndex = Math.max(0, CUSTOM_COMMAND_REFRESH_CHOICES_MS.indexOf(DEFAULT_CUSTOM_COMMAND_REFRESH_MS))
        return
      case 'create-refresh': {
        const choice = CUSTOM_COMMAND_REFRESH_CHOICES_MS[Math.min(this.pickerIndex, CUSTOM_COMMAND_REFRESH_CHOICES_MS.length - 1)]
        if (choice === undefined) return
        this.customRefresh = choice
        this.mode = 'create-timeout'
        // The picker opens on the DEFAULT timeout (300ms).
        this.pickerIndex = Math.max(0, CUSTOM_COMMAND_TIMEOUT_CHOICES_MS.indexOf(DEFAULT_COMMAND_TIMEOUT_MS))
        return
      }
      case 'create-timeout': {
        const choice = CUSTOM_COMMAND_TIMEOUT_CHOICES_MS[Math.min(this.pickerIndex, CUSTOM_COMMAND_TIMEOUT_CHOICES_MS.length - 1)]
        if (choice === undefined) return
        this.customTimeout = choice
        this.mode = 'create-tone'
        this.pickerIndex = 0
        return
      }
      case 'create-tone': {
        const choices = FOOTER_TONE_CHOICES
        const choice = choices[Math.min(this.pickerIndex, choices.length - 1)]
        if (choice === undefined) return
        const created = this.customKind === 'command'
          ? this.customItems.createCommand(this.customName, this.customCommand, this.customRefresh, this.customTimeout, choice.value)
          : this.customItems.create(this.customName, this.customText, choice.value)
        if (created.item === undefined) {
          this.customError = created.error ?? 'Custom footer item could not be created.'
          return
        }
        if (!this.addAvailable(created.item.id, this.addSide)) {
          // The row cap can only change through this model, but keep the
          // catalog transactional if a future caller changes it between the
          // picker render and Enter.
          this.customItems.remove(created.item.id)
          this.customError = 'The row is full — remove an item first.'
          return
        }
        this.mode = 'row'
        this.resetCustomFlow()
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
        if (this.pickerIndex >= matches.length) {
          if (this.flatCount() >= MAX_ITEMS_PER_ROW) return
          // The trailing actions: Create Custom Text, then Create Custom
          // Command (PR D §13.3).
          this.customKind = this.pickerIndex - matches.length === 1 ? 'command' : 'text'
          this.customName = ''
          this.customText = ''
          this.customCommand = ''
          this.customRefresh = DEFAULT_CUSTOM_COMMAND_REFRESH_MS
          this.customTimeout = DEFAULT_COMMAND_TIMEOUT_MS
          this.customTone = 'auto'
          this.customError = ''
          this.editBuffer = ''
          this.mode = 'create-name'
          return
        }
        const id = matches[Math.min(this.pickerIndex, matches.length - 1)]
        if (id === undefined) return
        const added = this.addAvailable(id, this.addSide)
        // ccstatusline parity: a SUCCESSFUL add closes the picker and
        // lands the cursor on the added item. A cap-refused add stays in
        // the picker (the '(row is full…)' notice explains why).
        if (added) this.mode = 'row'
        return
      }
      case 'exit-confirm':
        // Handled by the panel (PR E §14): Enter maps to the selected
        // exitConfirmAction(), which routes save/discard through the
        // panel's single save path and the close-without-write callback.
        return
    }
  }

  /** Esc: navigate back. Returns false exactly when the configurator
   * should CLOSE (Esc on a clean Row Selector). */
  cancel(): boolean {
    if ((this.mode === 'advanced' || this.mode === 'custom-text' || this.mode === 'custom-command' || this.mode === 'custom-name') && this.editing) {
      // First Esc inside an inline edit cancels the edit, not the page.
      this.editing = false
      this.editBuffer = ''
      this.customError = ''
      if (this.mode === 'custom-text' || this.mode === 'custom-command' || this.mode === 'custom-name') this.mode = 'item'
      return true
    }
    switch (this.mode) {
      case 'rows':
        // PR E §7: a clean draft closes immediately; a dirty draft opens
        // the exit-confirm page. A save in flight swallows the Esc — the
        // close decision belongs to the save's outcome, never to a
        // second concurrent exit path.
        if (this.saving) return true
        if (this.isDirty()) {
          this.mode = 'exit-confirm'
          this.exitConfirmCursor = 0
          return true
        }
        return false
      case 'exit-confirm':
        // Esc on the confirmation page IS "Keep Editing" (PR E §7.2) —
        // never a second close.
        if (this.saving) return true
        this.mode = 'rows'
        this.exitConfirmCursor = 0
        return true
      case 'add':
        if (this.addQuery !== '') {
          // A search term swallows the first Esc: clear the search.
          this.addQuery = ''
          this.pickerIndex = 0
          return true
        }
        this.mode = 'row'
        return true
      case 'create-name':
      case 'create-text':
      case 'create-command':
      case 'create-refresh':
      case 'create-timeout':
      case 'create-tone':
        // Creation is a child flow of the Add picker; cancellation never
        // closes the whole configurator and never mutates the draft catalog.
        this.mode = 'add'
        this.customError = ''
        this.editBuffer = ''
        return true
      case 'custom-delete':
      case 'custom-tone':
      case 'custom-refresh':
      case 'custom-timeout':
        this.mode = 'item'
        this.customError = ''
        return true
      case 'custom-text':
      case 'custom-command':
      case 'custom-name':
        this.mode = 'item'
        this.customError = ''
        this.editing = false
        this.editBuffer = ''
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

  /** Space (Edit Row page): remove the cursor's item placement (the
   * picker's catalog is derived from the registry — the DEFINITION stays
   * addable, and a second placement of the same id may remain placed). */
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
   * end; the cursor lands on it). The same id may be added REPEATEDLY —
   * each call appends an independent placement whose format/tone/prefix/
   * suffix/importance later diverge freely. Returns false — with NO
   * mutation — when the edited row is already at the parser's per-row
   * item cap: a 33rd item would make every future save fail to parse. */
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

  /** The custom definition tone picker opens on its current definition
   * value, not on the layout ref's independent tone override. */
  private currentCustomToneIndex(): number {
    const current = this.editedCustomItem()?.tone ?? 'auto'
    const choices = this.customToneChoices()
    const index = choices.findIndex(choice => choice.value === current)
    return index < 0 ? 0 : index
  }

  /** The refresh picker opens on the edited command item's current
   * EFFECTIVE refresh (an unlisted persisted value resolves to its appended
   * row — never a fake nearest choice). */
  private currentCustomRefreshIndex(): number {
    const item = this.editedCustomItem()
    const current = item?.kind === 'command'
      ? effectiveCustomCommandRefreshMs(item)
      : DEFAULT_CUSTOM_COMMAND_REFRESH_MS
    const index = this.customRefreshChoices().indexOf(current)
    return index < 0 ? 0 : index
  }

  /** The timeout picker opens on the edited command item's current
   * EFFECTIVE timeout. */
  private currentCustomTimeoutIndex(): number {
    const item = this.editedCustomItem()
    const current = item?.kind === 'command'
      ? effectiveCustomCommandTimeoutMs(item)
      : DEFAULT_COMMAND_TIMEOUT_MS
    const index = this.customTimeoutChoices().indexOf(current)
    return index < 0 ? 0 : index
  }

  /** Printable text: the add picker, custom-definition fields, or the
   * advanced inline editor's buffer. Everything else ignores it. */
  text(data: string): void {
    const clean = stripControlChars(data)
    if (clean === '') return
    if (this.mode === 'add') {
      this.addQuery = (this.addQuery + clean).slice(0, 64)
      this.pickerIndex = 0
      return
    }
    if (this.mode === 'create-name') {
      this.customName = [...this.customName + clean].slice(0, 64).join('')
      this.customError = ''
      return
    }
    if (this.mode === 'create-text') {
      this.customText = [...this.customText + clean].slice(0, 256).join('')
      this.customError = ''
      return
    }
    if (this.mode === 'create-command') {
      this.customCommand = this.customCommand + clean
      this.customError = ''
      return
    }
    if (this.mode === 'custom-text' || this.mode === 'custom-command' || this.mode === 'custom-name') {
      const limit = this.mode === 'custom-text' ? 256 : this.mode === 'custom-name' ? 64 : Infinity
      this.editBuffer = limit === Infinity
        ? this.editBuffer + clean
        : [...this.editBuffer + clean].slice(0, limit).join('')
      this.customError = ''
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
    if (this.mode === 'create-name') {
      this.customName = [...this.customName].slice(0, -1).join('')
      this.customError = ''
      return
    }
    if (this.mode === 'create-text') {
      this.customText = [...this.customText].slice(0, -1).join('')
      this.customError = ''
      return
    }
    if (this.mode === 'create-command') {
      this.customCommand = [...this.customCommand].slice(0, -1).join('')
      this.customError = ''
      return
    }
    if ((this.mode === 'custom-text' || this.mode === 'custom-command' || this.mode === 'custom-name') && this.editing) {
      this.editBuffer = [...this.editBuffer].slice(0, -1).join('')
      this.customError = ''
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

  /** Commit the custom definition's text without touching the layout ref. */
  private commitCustomText(): void {
    const id = this.editedRefId()
    const result = this.customItems.updateText(id, this.editBuffer)
    if (!result.ok) {
      this.customError = result.error ?? 'Text is invalid.'
      return
    }
    this.customError = ''
    this.editing = false
    this.editBuffer = ''
    this.mode = 'item'
  }

  /** Commit the custom command definition's command string (PR D). */
  private commitCustomCommand(): void {
    const id = this.editedRefId()
    const result = this.customItems.updateCommand(id, this.editBuffer)
    if (!result.ok) {
      this.customError = result.error ?? 'Command is invalid.'
      return
    }
    this.customError = ''
    this.editing = false
    this.editBuffer = ''
    this.mode = 'item'
  }

  /** Persist a command definition's refresh interval in the draft catalog. */
  private applyCustomRefresh(refreshIntervalMs: number): void {
    const id = this.editedRefId()
    const result = this.customItems.updateRefresh(id, refreshIntervalMs)
    if (!result.ok) this.customError = result.error ?? 'Refresh is invalid.'
    else this.customError = ''
  }

  /** Persist a command definition's timeout in the draft catalog. */
  private applyCustomTimeout(timeoutMs: number): void {
    const id = this.editedRefId()
    const result = this.customItems.updateTimeout(id, timeoutMs)
    if (!result.ok) this.customError = result.error ?? 'Timeout is invalid.'
    else this.customError = ''
  }

  /** Commit a custom definition rename and update every layout reference so
   * no dangling old `user:*` id remains. */
  private commitCustomName(): void {
    const oldId = this.editedRefId()
    const nextId = customItemId(this.editBuffer)
    if (nextId !== undefined && nextId !== oldId && this.registry.ids().includes(nextId)) {
      this.customError = `A footer item named "${customItemName(nextId)}" already exists.`
      return
    }
    const result = this.customItems.rename(oldId, this.editBuffer)
    if (result.newId === undefined) {
      this.customError = result.error ?? 'Name is invalid.'
      return
    }
    if (result.newId !== oldId) {
      for (const row of this.draft.rows) {
        row.left = row.left.map(ref => ref.id === oldId ? { ...ref, id: result.newId! } : ref)
        row.right = row.right.map(ref => ref.id === oldId ? { ...ref, id: result.newId! } : ref)
      }
    }
    this.customError = ''
    this.editing = false
    this.editBuffer = ''
    this.mode = 'item'
  }

  /** Remove every reference to a definition from every row. */
  private removeReferences(id: string): void {
    for (const row of this.draft.rows) {
      row.left = row.left.filter(ref => ref.id !== id)
      row.right = row.right.filter(ref => ref.id !== id)
    }
  }

  /** Clear the create flow's transient fields after a successful add. */
  private resetCustomFlow(): void {
    this.customName = ''
    this.customText = ''
    this.customKind = 'text'
    this.customCommand = ''
    this.customRefresh = DEFAULT_CUSTOM_COMMAND_REFRESH_MS
    this.customTimeout = DEFAULT_COMMAND_TIMEOUT_MS
    this.customTone = 'auto'
    this.customError = ''
    this.editing = false
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
    this.customName = ''
    this.customText = ''
    this.customKind = 'text'
    this.customCommand = ''
    this.customRefresh = DEFAULT_CUSTOM_COMMAND_REFRESH_MS
    this.customTimeout = DEFAULT_COMMAND_TIMEOUT_MS
    this.customTone = 'auto'
    this.customError = ''
    // The home selection returns to the first row: the layout identity
    // just changed, so a stale cursor could point past the Save action's
    // new index (PR E §4.2 — clamp/reanchor the home cursor).
    this.homeCursor = 0
    this.exitConfirmCursor = 0
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