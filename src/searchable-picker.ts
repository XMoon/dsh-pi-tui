/**
 * Host-owned searchable picker: the DSH product picker behavior migrated
 * out of the vendored `SelectList` fork (divergences X001/X002/X041 and
 * the SelectList side of X042). The vendored SelectList is restored to the
 * pinned upstream baseline; this component owns search, groups, dynamic
 * setItems(), the canonical filter query, PageUp/PageDown, the responsive
 * row budget, and search-Input focus forwarding.
 * @module @xmoon76/dsh-pi-tui/searchable-picker
 */

import {
  Input,
  dispatchMouseEvent,
  getKeybindings,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type SelectListTheme,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { singlePhysicalLine } from './presentation-lines.ts'

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32
const PRIMARY_COLUMN_GAP = 2
const MIN_DESCRIPTION_WIDTH = 10

// Description/badge presentation keeps its historical trim; the CR/LF
// collapse itself is the shared single-physical-row projection.
const normalizeToSingleLine = (text: string): string => singlePhysicalLine(text).trim()
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max))

/** One physical row of the last painted picker frame (mouse hit-testing).
 * The map is built from the EXACT final rows render() returns (including
 * the tiny-budget fitting paths), so a click can only ever act on
 * last-painted geometry. (Mouse parity.) */
type PickerMouseHit =
  | { kind: 'search'; width: number }
  | { kind: 'item'; value: string; index: number }
  | { kind: 'inert' }

/** Painted-row importance for the degenerate tiny-grant fit (lower survives,
 * plan §17): the search row and the SELECTED item's primary row outrank
 * plain items, nav chrome, detail, group headers, header chrome, spacers.
 * A wrapped badge row ties with the selected primary row so the selected
 * model's identity AND state survive before any neighbouring model. */
const ROW_PRIORITY = {
  search: 0,
  selectedItem: 0,
  wrappedBadge: 0,
  noMatch: 1,
  item: 1,
  indicator: 2,
  hint: 2,
  detail: 3,
  groupHeader: 4,
  header: 5,
  spacer: 6,
} as const

/** The original row indexes to keep when a tiny grant cannot fit the whole
 * frame: drop the highest priority NUMBER first (least important), and among
 * equal priorities the later row first, preserving the surviving rows' order. */
function pickKeptRowIndexes(priorities: readonly number[], limit: number): number[] {
  const dropped = new Set<number>()
  const order = priorities.map((_, index) => index).sort((a, b) => priorities[b]! - priorities[a]! || b - a)
  for (const index of order) {
    if (priorities.length - dropped.size <= limit) break
    dropped.add(index)
  }
  const kept: number[] = []
  for (let index = 0; index < priorities.length; index += 1) {
    if (!dropped.has(index)) kept.push(index)
  }
  return kept
}

/** One picker row; `group` renders a workspace-style header before the group. */
export interface SearchablePickerItem {
  value: string
  label: string
  description?: string
  group?: string
  /**
   * Stable GROUP IDENTITY for header transitions/counts when it must differ
   * from the rendered `group` label (e.g. two providers sharing a display
   * name, or a display section name colliding with another). Defaults to
   * `group`, so existing consumers keep byte-identical grouping. The header
   * still renders the `group` text (falling back to the key when absent).
   */
  groupKey?: string
  /**
   * Optional status text on the primary row (e.g. `current · high`). The
   * default `inline` layout renders it TRAILING the label; the opt-in
   * `wrap-when-needed` layout right-aligns it (see `badgeLayout`). A row
   * without a badge renders exactly as before.
   */
  badge?: string
  /**
   * LAYOUT-ONLY measurement for `badge` (defaults to `badge` when absent). A
   * caller that can change the rendered badge text while the row stays put
   * (e.g. cycling a value) passes the WIDEST badge the row can ever show here,
   * so the wrap decision — and therefore the physical row count — stays stable
   * as the visible badge changes. Only read when `badgeLayout` is
   * `wrap-when-needed`.
   */
  badgeLayoutText?: string
  /**
   * Extra lowercased-match aliases merged into the search index (e.g. a
   * provider id whose display name differs from the group header). Optional
   * and additive: a row without aliases searches exactly as before.
   */
  searchText?: string
}

/** The upstream SelectList palette plus the Host group-header style. */
export interface SearchablePickerTheme extends SelectListTheme {
  /** Optional style for group header rows (Host contract; upstream has none). */
  groupHeader?: (text: string) => string
}

export interface SearchablePickerTruncatePrimaryContext {
  text: string
  maxWidth: number
  columnWidth: number
  item: SearchablePickerItem
  isSelected: boolean
}

export interface SearchablePickerLayoutOptions {
  minPrimaryColumnWidth?: number
  maxPrimaryColumnWidth?: number
  truncatePrimary?: (context: SearchablePickerTruncatePrimaryContext) => string
}

export interface SearchablePickerOptions {
  /**
   * Show a search input above the list. Typing filters items by a
   * case-insensitive substring over value, label, description, the group
   * label/`groupKey`, and any `searchText` aliases.
   */
  enableSearch?: boolean
  /**
   * Optional header line rendered above the search input. When search is
   * enabled the header also carries the live `filtered/total` counts.
   */
  header?: string
  /** Message rendered when the (filtered) list is empty. */
  noMatchText?: string
  /**
   * Render the key-hint footer line. Off by default so inline usages keep
   * their compact height.
   */
  showHint?: boolean
  /**
   * Override the footer hint text. Defaults to the generic picker hint;
   * existing consumers omit it and keep the default wording.
   */
  hint?: string
  /**
   * Pre-fill the search box when the picker opens (e.g. `/sessions <query>`).
   */
  initialQuery?: string
  /**
   * How an item's `description` renders. `column` (default) keeps the
   * historical right-column layout for every row; `selected-below` renders
   * the description on its own physical row under the SELECTED item only
   * (command-palette detail), keeping the list dense. Existing consumers
   * omit this and keep the column behavior byte-for-byte.
   */
  descriptionMode?: 'column' | 'selected-below'
  /**
   * How a row's `badge` shares space with its label. `inline` (default) keeps
   * the historical behavior (the label yields width, the badge TRAILS it, and
   * a too-long badge may squeeze the label out entirely). `wrap-when-needed`
   * is the opt-in ADVANCED layout: the badge is RIGHT-ALIGNED against the row
   * edge, and whenever the item's `badgeLayoutText` does not fit beside the
   * FULL label it moves onto a right-aligned, INERT second physical line, so
   * the primary identity can never be squeezed out. Existing consumers omit
   * this and keep the inline/trailing behavior.
   */
  badgeLayout?: 'inline' | 'wrap-when-needed'
}

export class SearchablePicker implements Component, Focusable {
  private items: SearchablePickerItem[] = []
  private filteredItems: SearchablePickerItem[] = []
  /**
   * The CANONICAL filter query. One source of truth for getFilter(),
   * setItems() re-application and the rendered search box: a programmatic
   * setFilter(), a setItems() refresh and user typing all write through
   * applyFilter(), so they can never drift apart (a setFilter that only
   * narrowed filteredItems left getFilter() reading a stale search box and
   * the next keystroke silently dropping the programmatic query).
   * (Moved from fork divergence X041; upstream has no search at all.)
   */
  private filterQuery = ''
  /** Lowercased searchable text per item (value + label + description +
   *  group/groupKey + `searchText` aliases), rebuilt on setItems. */
  private searchTexts = new Map<SearchablePickerItem, string>()
  private selectedIndex: number = 0
  /** Caller-configured item cap; the host may lower it for a short frame. */
  private configuredMaxVisible: number
  private maxVisible: number = 5
  /** Inner row budget supplied by a root-owned responsive overlay. */
  private maxRows = Number.POSITIVE_INFINITY
  private theme: SearchablePickerTheme
  private layout: SearchablePickerLayoutOptions
  private options: SearchablePickerOptions
  private searchInput?: Input
  private searchEnabled: boolean
  private descriptionMode: 'column' | 'selected-below'
  /** Physical row → hit entry from the LAST render (mouse parity). */
  private hitMap: PickerMouseHit[] = []
  /** The width the hit map was painted at; a stale-width event is rejected. */
  private lastRenderWidth = 0
  /** The pressed item's VALUE (mouse parity): a synthesized click may only
   * activate the exact logical item that was pressed — an async setItems()
   * between press and release must never transfer activation to whatever
   * moved into the same physical row. */
  private mousePressedValue: string | undefined

  public onSelect?: (item: SearchablePickerItem) => void
  public onCancel?: () => void
  public onSelectionChange?: (item: SearchablePickerItem) => void

  /**
   * Focusable (moved from fork divergence X042): the focused flag
   * propagates to the search Input so it emits the hardware CURSOR_MARKER
   * for IME candidate-window positioning. The wrapper contract: every
   * component owning an Input/Editor must forward focus; a plain Component
   * swallows the flag and the IME misplaces its candidate window.
   */
  private _focused = false
  get focused(): boolean {
    return this._focused
  }
  set focused(value: boolean) {
    this._focused = value
    if (this.searchInput !== undefined) this.searchInput.focused = value
  }

  constructor(
    items: SearchablePickerItem[],
    maxVisible: number,
    theme: SearchablePickerTheme,
    layout: SearchablePickerLayoutOptions = {},
    options: SearchablePickerOptions = {},
  ) {
    this.items = items
    this.filteredItems = items
    this.searchTexts = this.buildSearchTexts(items)
    this.configuredMaxVisible = Math.max(1, Math.floor(maxVisible))
    this.maxVisible = this.configuredMaxVisible
    this.theme = theme
    this.layout = layout
    this.options = options
    this.searchEnabled = options.enableSearch ?? false
    this.descriptionMode = options.descriptionMode ?? 'column'
    if (this.searchEnabled) {
      this.searchInput = new Input()
      const initial = options.initialQuery ?? ''
      if (initial !== '') {
        this.searchInput.setValue(initial)
        this.applyFilter(initial)
      }
    }
  }

  /** Update the live inner row budget without resetting filter or selection. */
  setMaxRows(rows: number): void {
    this.maxRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : Number.POSITIVE_INFINITY
    this.recomputeVisibleBudget()
  }

  /** Update the empty-state message while the picker is open (e.g. to tell a
   *  still-loading progressive fill apart from a settled empty catalog). */
  setNoMatchText(text: string): void {
    this.options.noMatchText = text
  }

  /** Update the footer hint while the picker is open (e.g. an owner that
   *  switches interaction modes on the same list). */
  setHint(text: string): void {
    this.options.hint = text
  }

  /** Reserve the list chrome before deriving the item count. */
  private recomputeVisibleBudget(): void {
    const prefix = (this.options.header === undefined ? 0 : 2) + (this.searchEnabled ? 2 : 0)
    const hint = this.options.showHint === true || this.searchEnabled ? 2 : 0
    const indicator = this.filteredItems.length > 1 ? 1 : 0
    const group = this.filteredItems.some(item => this.groupKeyOf(item) !== '') ? 1 : 0
    // selected-below: the selected row's detail is a real physical row, so
    // reserve it against the item budget (a later selection move reuses the
    // same slot). Rows without a description keep the full grant.
    const detail = this.descriptionMode === 'selected-below'
      && this.filteredItems[this.selectedIndex]?.description !== undefined ? 1 : 0
    const budget = this.maxRows === Number.POSITIVE_INFINITY
      ? this.configuredMaxVisible
      : this.maxRows - prefix - hint - indicator - group - detail
    this.maxVisible = Math.max(1, Math.min(this.configuredMaxVisible, budget))
  }

  /**
   * Replace the item list while the picker is open (e.g. enriching rows
   * with titles as they load). The active search query is re-applied; the
   * currently selected row (matched by value) stays selected when it
   * survives the refresh, instead of snapping back to the top.
   * (Moved from fork divergence X002.)
   */
  setItems(items: SearchablePickerItem[]): void {
    this.items = items
    this.searchTexts = this.buildSearchTexts(items)
    // Re-apply the CANONICAL query (not the search box's value): a
    // programmatic setFilter() must survive an async row refresh.
    this.applyFilter(this.filterQuery, true)
  }

  /** The current search query (the CANONICAL query — with search disabled a
   * programmatic setFilter() still narrows the list, so this returns the
   * canonical query, not "empty when search is disabled"). */
  getFilter(): string {
    return this.filterQuery
  }

  setFilter(filter: string): void {
    // Sync the search box so the box, the filter and getFilter() can
    // never diverge; the setValue cursor lands at the end so the user's
    // next keystroke APPENDS to the programmatic query instead of
    // prepending in front of it.
    if (this.searchEnabled && this.searchInput !== undefined && this.searchInput.getValue() !== filter) {
      this.searchInput.setValue(filter)
    }
    this.applyFilter(filter)
  }

  setSelectedIndex(index: number): void {
    this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1))
  }

  /**
   * Select by logical VALUE within the FILTERED list (identity-based initial
   * selection for a picker opened onto a known row). An unmatched value is a
   * no-op — the caller's default selection stands — so a caller can never
   * accidentally select a same-id row from a different group. The value
   * survives a later `setItems()` through the existing value-preserving
   * refresh.
   */
  setSelectedValue(value: string): void {
    const index = this.filteredItems.findIndex(item => item.value === value)
    if (index !== -1) this.selectedIndex = index
  }

  /**
   * The current selection index within the FILTERED list.
   *
   * Deliberate Host contract expansion (PR1 plan §8/§10.1): the zero-match
   * invariant — navigation on an empty list is a no-op, so the index never
   * goes invalid (-1/1) — is an acceptance criterion of the migration, and
   * the plan's test matrix requires observing it without private-field
   * access. This read counterpart of the existing public setSelectedIndex
   * is the minimal public surface that makes the invariant observable; the
   * class is Host-internal (not exported from the package surface).
   */
  getSelectedIndex(): number {
    return this.selectedIndex
  }

  invalidate(): void {
    // No cached state to invalidate currently
  }

  render(width: number): string[] {
    const lines: string[] = []
    const hits: PickerMouseHit[] = []
    const priorities: number[] = []
    const push = (line: string, hit: PickerMouseHit, priority: number): void => {
      lines.push(line)
      hits.push(hit)
      priorities.push(priority)
    }

    if (this.options.header !== undefined) {
      const countSuffix = this.searchEnabled ? `  ${this.filteredItems.length}/${this.items.length}` : ''
      const headerText = truncateToWidth(`${singlePhysicalLine(this.options.header)}${countSuffix}`, width, '')
      push((this.theme.groupHeader ?? this.theme.description)(headerText), { kind: 'inert' }, ROW_PRIORITY.header)
      push('', { kind: 'inert' }, ROW_PRIORITY.spacer)
    }

    if (this.searchEnabled && this.searchInput) {
      const searchLine = this.searchInput.render(width)[0] ?? ''
      push(searchLine, { kind: 'search', width }, ROW_PRIORITY.search)
      push('', { kind: 'inert' }, ROW_PRIORITY.spacer)
    }

    // If no items match filter, show message
    if (this.filteredItems.length === 0) {
      // The empty/error message is untrusted-length (a catalog failure can
      // carry an arbitrary transport message): project its CR/LF onto one
      // row and clip it to the grant so the overlay can never be widened
      // — or wrapped into extra rows — by its own status text.
      const noMatch = truncateToWidth(singlePhysicalLine(this.options.noMatchText ?? '  No matching commands'), width, '')
      push(this.theme.noMatch(noMatch), { kind: 'inert' }, ROW_PRIORITY.noMatch)
      if (this.options.showHint === true || this.searchEnabled) this.addHintLine(lines, hits, priorities, width)
      const result = this.finalizeEmpty(lines, hits)
      this.hitMap = result.hits
      this.lastRenderWidth = width
      return result.lines
    }

    const primaryColumnWidth = this.getPrimaryColumnWidth()
    const showHint = this.options.showHint === true || this.searchEnabled
    const limit = Number.isFinite(this.maxRows) ? Math.max(1, Math.floor(this.maxRows)) : Number.POSITIVE_INFINITY
    const hintRows = showHint ? 2 : 0

    let visibleCount = this.maxVisible
    let window = this.renderItemWindow(width, primaryColumnWidth, visibleCount)
    // Group headers consume physical rows beyond the reserved one: a
    // window spanning k groups renders k headers, so the assembled list
    // can exceed the host-granted row budget. Shrink the WINDOW (still
    // selection-centered) until the whole list fits. Only the local
    // `visibleCount` shrinks — `maxVisible` stays the budget-derived
    // baseline, so a later selection move can use the full grant again
    // (a render-time ratchet would permanently shrink PageUp/PageDown).
    while (Number.isFinite(this.maxRows)
      && lines.length + window.lines.length + hintRows > this.maxRows
      && visibleCount > 1) {
      visibleCount -= 1
      window = this.renderItemWindow(width, primaryColumnWidth, visibleCount)
    }
    for (let index = 0; index < window.lines.length; index += 1) {
      push(window.lines[index]!, window.hits[index]!, window.priorities[index]!)
    }
    if (showHint) this.addHintLine(lines, hits, priorities, width)
    if (Number.isFinite(this.maxRows) && lines.length > this.maxRows) {
      // Degenerate tiny grants: yield the LEAST important rows first instead
      // of tail-slicing, which would keep the hint/spacers and could drop the
      // selected item's primary row. Priority follows plan §17 (search and the
      // selected primary outrank detail, group headers, header chrome,
      // spacers and the hint); the hit map is transformed identically.
      const kept = pickKeptRowIndexes(priorities, limit)
      this.hitMap = kept.map(index => hits[index]!)
      this.lastRenderWidth = width
      return kept.map(index => lines[index]!)
    }
    this.hitMap = hits
    this.lastRenderWidth = width
    return lines
  }

  /** Finalize the empty/no-match assembly against the live grant. The
   * setMaxRows contract covers every path: `render().length <= maxRows`
   * with the semantic priority search input > no-match message > hint >
   * header > blank spacers, so the hint survives whenever the grant
   * physically allows it. The hit map is transformed identically. */
  private finalizeEmpty(lines: string[], hits: PickerMouseHit[]): { lines: string[]; hits: PickerMouseHit[] } {
    if (!Number.isFinite(this.maxRows)) return { lines, hits }
    const limit = Math.max(1, Math.floor(this.maxRows))
    if (lines.length <= limit) return { lines, hits }
    // Blank spacers are the lowest-value rows: drop them first (the
    // content stays together and keeps its visual order).
    const compact: string[] = []
    const compactHits: PickerMouseHit[] = []
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] !== '') {
        compact.push(lines[index]!)
        compactHits.push(hits[index]!)
      }
    }
    if (compact.length <= limit) return { lines: compact, hits: compactHits }
    // The header is chrome: yield it before any content (priority:
    // hint > header).
    const withoutHeader = this.options.header === undefined ? compact : compact.slice(1)
    const withoutHeaderHits = this.options.header === undefined ? compactHits : compactHits.slice(1)
    if (withoutHeader.length <= limit) return { lines: withoutHeader, hits: withoutHeaderHits }
    // Extreme grant: keep the head of the HEADER-FREE rows — the search
    // input, then the no-match message. Slicing `compact` here would
    // re-introduce the header and drop the message, which the declared
    // priority places ABOVE the header.
    return { lines: withoutHeader.slice(0, limit), hits: withoutHeaderHits.slice(0, limit) }
  }

  /** Render the item window (group headers + item rows + scroll indicator)
   * at `visibleCount`, centered on the selected row, with the matching
   * mouse hit entries. */
  private renderItemWindow(
    width: number,
    primaryColumnWidth: number,
    visibleCount: number,
  ): { lines: string[]; hits: PickerMouseHit[]; priorities: number[] } {
    const lines: string[] = []
    const hits: PickerMouseHit[] = []
    const priorities: number[] = []

    // Calculate visible range with scrolling
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(visibleCount / 2), this.filteredItems.length - visibleCount),
    )
    const endIndex = Math.min(startIndex + visibleCount, this.filteredItems.length)

    // Group counts over the full (filtered) sequence, so a header inside
    // the visible window can show how many items its group holds. The key is
    // the identity (`groupKey`) so distinct providers that share a display
    // name never merge; the rendered header still uses the display label.
    const groupCounts = new Map<string, number>()
    for (const item of this.filteredItems) {
      const key = this.groupKeyOf(item)
      if (key === '') continue
      groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1)
    }

    // Render visible items, emitting a header row whenever the group of
    // the next item differs from the previous one (ungrouped items form
    // an implicit anonymous group so groups do not bleed across them).
    let lastGroup: string | undefined = undefined
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i]
      if (!item) continue

      const groupKey = this.groupKeyOf(item)
      if (groupKey !== lastGroup) {
        if (groupKey !== '') {
          const count = groupCounts.get(groupKey) ?? 0
          const label = item.group ?? groupKey
          const headerText = truncateToWidth(`  ${singlePhysicalLine(label)} · ${count}`, width, '')
          lines.push((this.theme.groupHeader ?? this.theme.description)(headerText))
          hits.push({ kind: 'inert' })
          priorities.push(ROW_PRIORITY.groupHeader)
        }
        lastGroup = groupKey
      }

      const isSelected = i === this.selectedIndex
      const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined
      const itemPriority = isSelected ? ROW_PRIORITY.selectedItem : ROW_PRIORITY.item
      // wrap-when-needed: when the item's badge cannot share the primary row
      // with the FULL label, the badge moves to an inert second physical row.
      // The decision depends only on the item content and the width (never on
      // `isSelected`, both prefixes are 2 cells) and is measured from
      // `badgeLayoutText`, so a caller that cycles the visible badge keeps the
      // physical row count stable.
      if (this.shouldWrapBadge(item, width)) {
        const prefix = isSelected ? '→ ' : '  '
        const prefixWidth = visibleWidth(prefix)
        const label = truncateToWidth(this.getDisplayValue(item), Math.max(1, width - prefixWidth), '')
        lines.push(isSelected ? this.theme.selectedText(`${prefix}${label}`) : `${prefix}${label}`)
        hits.push({ kind: 'item', value: item.value, index: i })
        priorities.push(itemPriority)
        const badge = normalizeToSingleLine(item.badge!)
        lines.push(this.theme.description(this.wrappedBadgeLine(badge, width)))
        hits.push({ kind: 'inert' })
        priorities.push(ROW_PRIORITY.wrappedBadge)
      } else {
        lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth))
        hits.push({ kind: 'item', value: item.value, index: i })
        priorities.push(itemPriority)
      }
      // selected-below: the selected item's detail is a real physical row
      // (inert in the hit map, so a pointer event on it can never activate a
      // neighbour), counted by the row-budget fit loop above. A wrapped badge
      // does not suppress it (a failure row keeps its diagnostic detail).
      if (this.descriptionMode === 'selected-below' && isSelected && descriptionSingleLine !== undefined) {
        lines.push(this.theme.description(truncateToWidth(`    ${descriptionSingleLine}`, width, '')))
        hits.push({ kind: 'inert' })
        priorities.push(ROW_PRIORITY.detail)
      }
    }

    // Add scroll indicators if needed
    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`
      // Truncate if too long for terminal
      lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, '')))
      hits.push({ kind: 'inert' })
      priorities.push(ROW_PRIORITY.indicator)
    }

    return { lines, hits, priorities }
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings()
    // Navigation/selection always operates on the FILTERED list (which
    // tracks the live query whether or not search is enabled): with
    // search disabled, setFilter narrows filteredItems, so bounds over
    // the raw items would walk into invisible rows. (Moved from fork
    // divergence X001; upstream semantics restored.)
    const displayItems = this.filteredItems
    // Zero-match invariant: with nothing to navigate, every navigation
    // key is a no-op — selectedIndex must stay 0 (a wrap on an empty
    // list would otherwise produce -1/1 and break the invariant).
    // Search keys still reach the search box below (typing refines the
    // query), so the guard sits on the navigation branches only.
    if (displayItems.length === 0) {
      if (
        kb.matches(keyData, 'tui.select.up') ||
        kb.matches(keyData, 'tui.select.down') ||
        kb.matches(keyData, 'tui.select.pageUp') ||
        kb.matches(keyData, 'tui.select.pageDown')
      ) {
        return
      }
    }
    // Up arrow - wrap to bottom when at top
    if (kb.matches(keyData, 'tui.select.up')) {
      this.selectedIndex = this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1
      this.notifySelectionChange()
    }
    // Down arrow - wrap to top when at bottom
    else if (kb.matches(keyData, 'tui.select.down')) {
      this.selectedIndex = this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1
      this.notifySelectionChange()
    }
    // Page up/down - move by a visible page
    else if (kb.matches(keyData, 'tui.select.pageUp')) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible)
      this.notifySelectionChange()
    } else if (kb.matches(keyData, 'tui.select.pageDown')) {
      this.selectedIndex = Math.min(displayItems.length - 1, this.selectedIndex + this.maxVisible)
      this.notifySelectionChange()
    }
    // Enter
    else if (kb.matches(keyData, 'tui.select.confirm')) {
      const selectedItem = displayItems[this.selectedIndex]
      if (selectedItem && this.onSelect) {
        this.onSelect(selectedItem)
      }
    }
    // Escape or Ctrl+C
    else if (kb.matches(keyData, 'tui.select.cancel')) {
      if (this.onCancel) {
        this.onCancel()
      }
    }
    // Any other key edits the search box when search is enabled. Only a
    // VALUE change re-derives the filtered list (which resets the selection
    // to the top): a cursor move (left/right/ctrl+…) or a key the Input
    // ignores must not throw away the user's current row.
    else if (this.searchEnabled && this.searchInput) {
      const before = this.searchInput.getValue()
      this.searchInput.handleInput(keyData)
      const after = this.searchInput.getValue()
      if (after !== before) this.applyFilter(after)
    }
  }

  /**
   * Mouse parity (v0.85.1 SelectList-style interaction on the Host
   * picker): the hit map from the LAST render decides what a pointer
   * event may act on — the search Input row, an item row, or inert
   * chrome (headers, group headers, blank spacers, scroll indicator,
   * hint, no-match text). A press records the pressed item's VALUE; a
   * synthesized click only activates when the same physical row still
   * resolves to that exact value, so an async setItems() between press
   * and release can never transfer activation to a different item.
   * Wheel moves one logical selection step (wrapping like the keyboard).
   */
  handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
    // A click ends any gesture, and every left press starts a fresh
    // one: release the pressed identity up front — BEFORE the width
    // guard / hit lookup / search dispatch / inert return, so a
    // delegated search press (or a press on stale-width or missing-hit
    // geometry) still replaces the old latch. The TUI keeps the picker
    // as the press target for a handled search press, so a later
    // release on the same cell synthesizes a click that must not match
    // a stale identity. The local copy still guards the valid-row
    // comparison below.
    const pressedValue = this.mousePressedValue
    if (event.type === 'click' || (event.type === 'press' && event.button === 'left')) {
      this.mousePressedValue = undefined
    }
    // The hit map is only valid for the last painted width: a resize
    // that has not been repainted must not dispatch against stale
    // geometry (last-painted geometry is authoritative).
    if (event.width !== this.lastRenderWidth) return undefined
    const hit = this.hitMap[event.y]
    if (!hit) return undefined

    if (hit.kind === 'search') {
      if (event.type !== 'press') return undefined
      if (this.searchInput === undefined) return undefined
      // The search Input occupies the full row; translate to its local
      // coordinates and rewrite the gesture/focus target to THIS picker
      // (the Input is a private field not reachable from the mounted
      // tree — X018 liveness tracks the mounted unit).
      const result = dispatchMouseEvent(this.searchInput, { ...event, y: 0 })
      if (!result) return undefined
      return {
        ...result,
        ...(result.focus ? { focusTarget: this } : {}),
        target: {
          component: this,
          originX: event.screenX - event.x,
          originY: event.screenY - event.y,
          width: event.width,
          height: event.height,
        },
      }
    }

    if (hit.kind === 'item') {
      if (event.type === 'wheel' && event.wheelDelta) {
        if (this.filteredItems.length === 0) return undefined
        const delta = event.wheelDelta < 0 ? -1 : 1
        const previousIndex = this.selectedIndex
        if (delta < 0) {
          this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1
        } else {
          this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1
        }
        if (this.selectedIndex !== previousIndex) this.notifySelectionChange()
        return { handled: true, render: this.selectedIndex !== previousIndex }
      }
      if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) return undefined
      if (event.type === 'press') {
        // The hit map is last-painted geometry: resolve the CURRENT
        // index by the pressed VALUE (a setItems() between paint and
        // press may have reordered rows WITHOUT a repaint, so the stale
        // index can point at a different item). No match => reject the
        // press — the pressed row no longer exists.
        const currentIndex = this.filteredItems.findIndex(candidate => candidate.value === hit.value)
        if (currentIndex === -1) return undefined
        this.mousePressedValue = hit.value
        if (this.selectedIndex !== currentIndex) {
          this.selectedIndex = currentIndex
          this.notifySelectionChange()
        }
        return { handled: true, focus: true }
      }
      // click: activation must not transfer to a different logical item
      // after an async refresh. The hit map is last-painted geometry, so
      // the pressed VALUE is the identity — resolve the CURRENT item by
      // that value (a setItems() between press and release may have
      // reordered/replaced rows WITHOUT a repaint yet, so the index in
      // the stale hit map can point at a different item). No match => drop.
      if (pressedValue !== hit.value) return undefined
      const item = this.filteredItems.find(candidate => candidate.value === hit.value)
      if (item && this.onSelect) this.onSelect(item)
      return { handled: true }
    }

    return undefined
  }

  /** Re-derive the filtered list from the current query and clamp selection.
   * `preserveSelection` keeps the currently selected row (by value) when it
   * survives the filter — used by setItems, where the query did not change
   * and snapping back to the top would fight the user's cursor. */
  private applyFilter(query: string, preserveSelection = false): void {
    this.filterQuery = query
    const previousValue = preserveSelection ? this.filteredItems[this.selectedIndex]?.value : undefined
    if (query === '') {
      this.filteredItems = this.items
    } else {
      const needle = query.toLowerCase()
      this.filteredItems = this.items.filter((item) => {
        // Precomputed lowercased search text: filtering a large picker
        // no longer re-lowercases every field on every keystroke.
        const searchable = this.searchTexts.get(item)
        return searchable === undefined
          ? this.searchableTextOf(item).includes(needle)
          : searchable.includes(needle)
      })
    }
    this.recomputeVisibleBudget()
    if (previousValue !== undefined) {
      const index = this.filteredItems.findIndex(item => item.value === previousValue)
      if (index !== -1) {
        this.selectedIndex = index
        return
      }
    }
    this.selectedIndex = 0
  }

  /** Lowercased value+label+description+group+aliases per item, for fast
   * filtering. The group is searchable so a provider name/id finds its
   * models; `searchText` carries aliases the display row does not show. */
  private buildSearchTexts(items: SearchablePickerItem[]): Map<SearchablePickerItem, string> {
    return new Map(items.map(item => [item, this.searchableTextOf(item)]))
  }

  /** The stable group identity: `groupKey` when set, else the `group` label. */
  private groupKeyOf(item: SearchablePickerItem): string {
    return item.groupKey ?? item.group ?? ''
  }

  private searchableTextOf(item: SearchablePickerItem): string {
    return [
      item.value,
      item.label,
      item.description ?? '',
      item.group ?? '',
      item.groupKey ?? '',
      item.searchText ?? '',
    ].join('\n').toLowerCase()
  }

  private addHintLine(lines: string[], hits: PickerMouseHit[], priorities: number[], width: number): void {
    const hint = this.options.hint ?? (this.searchEnabled
      ? 'type to filter · ↑↓ navigate · enter select · esc close'
      : '↑↓ navigate · enter select · esc close')
    lines.push('')
    hits.push({ kind: 'inert' })
    priorities.push(ROW_PRIORITY.spacer)
    lines.push(this.theme.scrollInfo(truncateToWidth(`  ${hint}`, width - 2, '')))
    hits.push({ kind: 'inert' })
    priorities.push(ROW_PRIORITY.hint)
  }

  private renderItem(
    item: SearchablePickerItem,
    isSelected: boolean,
    width: number,
    descriptionSingleLine: string | undefined,
    primaryColumnWidth: number,
  ): string {
    const prefix = isSelected ? '→ ' : '  '
    const prefixWidth = visibleWidth(prefix)

    // selected-below (command-palette detail) and any row carrying a badge
    // render a single primary line; the description column below is skipped
    // (selected-below shows it on its own row; a badge row has no column).
    if (this.descriptionMode === 'selected-below' || item.badge !== undefined) {
      return this.renderPrimaryLine(item, prefix, prefixWidth, width, isSelected)
    }

    if (descriptionSingleLine && width > 40) {
      const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4))
      const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP)
      const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth)
      const truncatedValueWidth = visibleWidth(truncatedValue)
      const spacing = ' '.repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth))
      const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length
      const remainingWidth = width - descriptionStart - 2 // -2 for safety

      if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
        const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, '')
        if (isSelected) {
          return this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`)
        }

        const descText = this.theme.description(spacing + truncatedDesc)
        return prefix + truncatedValue + descText
      }
    }

    const maxWidth = width - prefixWidth - 2
    const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth)
    if (isSelected) {
      return this.theme.selectedText(`${prefix}${truncatedValue}`)
    }

    return prefix + truncatedValue
  }

  /** The wrapped badge line, right-aligned against the row edge. When the
   *  badge is itself wider than the grant it drops from the LEFT (keeping the
   *  most specific TAIL, e.g. `/model`'s effort token) rather than truncating
   *  the tail away, so an ultra-narrow row never loses the value the user is
   *  actively editing. */
  private wrappedBadgeLine(badge: string, width: number): string {
    const text = visibleWidth(badge) <= width
      ? badge
      : `…${this.tailToWidth(badge, Math.max(1, width - 1))}`
    return ' '.repeat(Math.max(0, width - visibleWidth(text))) + text
  }

  /** The longest SUFFIX of `text` whose visible width does not exceed `width`. */
  private tailToWidth(text: string, width: number): string {
    const chars = Array.from(text)
    let start = 0
    while (start < chars.length && visibleWidth(chars.slice(start).join('')) > width) start += 1
    return chars.slice(start).join('')
  }

  /** `wrap-when-needed`: move this item's badge to a second physical row when
   *  the FULL label plus the LAYOUT badge (2-cell prefix + 2-cell gap) cannot
   *  fit the grant. Selection-independent, so moving the cursor never changes
   *  an item's own physical height. */
  private shouldWrapBadge(item: SearchablePickerItem, width: number): boolean {
    if (this.options.badgeLayout !== 'wrap-when-needed') return false
    if (item.badge === undefined || item.badge === '') return false
    const measure = normalizeToSingleLine(item.badgeLayoutText ?? item.badge)
    const needed = 2 + visibleWidth(this.getDisplayValue(item)) + 2 + visibleWidth(measure)
    return needed > width
  }

  /** One primary row with an optional right-aligned badge. The label yields
   * width to the badge (the badge is the status fact, the label the value);
   * on a row too narrow for both, the status wins and is itself clipped. */
  private renderPrimaryLine(
    item: SearchablePickerItem,
    prefix: string,
    prefixWidth: number,
    width: number,
    isSelected: boolean,
  ): string {
    const badge = item.badge === undefined ? undefined : normalizeToSingleLine(item.badge)
    const badgeSuffix = badge === undefined || badge === '' ? '' : `  ${badge}`
    const badgeWidth = visibleWidth(badgeSuffix)
    const labelBudget = width - prefixWidth - badgeWidth
    if (labelBudget < 1) {
      const text = truncateToWidth(`${prefix}${badge ?? ''}`, width, '')
      return isSelected ? this.theme.selectedText(text) : this.theme.description(text)
    }
    const label = truncateToWidth(this.getDisplayValue(item), labelBudget, '')
    if (badgeSuffix === '') return isSelected ? this.theme.selectedText(`${prefix}${label}`) : prefix + label
    // Only the OPT-IN advanced badge layout (wrap-when-needed, used by /model)
    // also RIGHT-ALIGNS the badge against the row edge. The default `inline`
    // layout keeps the historical TRAILING badge byte-for-byte for every other
    // consumer (e.g. the /settings allowlist's allowed/unavailable badges).
    if (this.options.badgeLayout !== 'wrap-when-needed') {
      if (isSelected) {
        return this.theme.selectedText(truncateToWidth(`${prefix}${label}${badgeSuffix}`, width, ''))
      }
      return prefix + label + this.theme.description(badgeSuffix)
    }
    const pad = ' '.repeat(Math.max(0, labelBudget - visibleWidth(label)))
    if (isSelected) {
      return this.theme.selectedText(truncateToWidth(`${prefix}${label}${pad}${badgeSuffix}`, width, ''))
    }
    return `${prefix}${label}${pad}` + this.theme.description(badgeSuffix)
  }

  private getPrimaryColumnWidth(): number {
    const { min, max } = this.getPrimaryColumnBounds()
    const widestPrimary = this.filteredItems.reduce((widest, item) => {
      return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP)
    }, 0)

    return clamp(widestPrimary, min, max)
  }

  private getPrimaryColumnBounds(): { min: number; max: number } {
    const rawMin =
      this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH
    const rawMax =
      this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH

    return {
      min: Math.max(1, Math.min(rawMin, rawMax)),
      max: Math.max(1, Math.max(rawMin, rawMax)),
    }
  }

  private truncatePrimary(
    item: SearchablePickerItem,
    isSelected: boolean,
    maxWidth: number,
    columnWidth: number,
  ): string {
    const displayValue = this.getDisplayValue(item)
    const truncatedValue = this.layout.truncatePrimary
      ? this.layout.truncatePrimary({
          text: displayValue,
          maxWidth,
          columnWidth,
          item,
          isSelected,
        })
      : truncateToWidth(displayValue, maxWidth, '')

    return truncateToWidth(truncatedValue, maxWidth, '')
  }

  private getDisplayValue(item: SearchablePickerItem): string {
    // Single-row contract: the primary display value is projected so an
    // embedded CR/LF can never leak into the framebuffer as extra
    // physical rows; measurement (column width, badge wrap) and rendering
    // share the same projection. Deliberately NOT trimmed — a label may
    // carry structural whitespace. Search stays RAW (see
    // searchableTextOf): a multiline label still matches by any of its
    // lines while the row renders collapsed.
    return singlePhysicalLine(item.label || item.value)
  }

  private notifySelectionChange(): void {
    // selected-below: the detail row of the NEW selection changes the row
    // budget, so re-derive the item grant after the move.
    if (this.descriptionMode === 'selected-below') this.recomputeVisibleBudget()
    const selectedItem = this.filteredItems[this.selectedIndex]
    if (selectedItem && this.onSelectionChange) {
      this.onSelectionChange(selectedItem)
    }
  }

  getSelectedItem(): SearchablePickerItem | null {
    const item = this.filteredItems[this.selectedIndex]
    return item || null
  }
}
