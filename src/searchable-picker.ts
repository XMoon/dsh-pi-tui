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

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32
const PRIMARY_COLUMN_GAP = 2
const MIN_DESCRIPTION_WIDTH = 10

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, ' ').trim()
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max))

/** One physical row of the last painted picker frame (mouse hit-testing).
 * The map is built from the EXACT final rows render() returns (including
 * the tiny-budget slicing paths), so a click can only ever act on
 * last-painted geometry. (Mouse parity.) */
type PickerMouseHit =
  | { kind: 'search'; width: number }
  | { kind: 'item'; value: string; index: number }
  | { kind: 'inert' }

/** One picker row; `group` renders a workspace-style header before the group. */
export interface SearchablePickerItem {
  value: string
  label: string
  description?: string
  group?: string
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
   * case-insensitive substring over value, label, and description.
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
   * Pre-fill the search box when the picker opens (e.g. `/sessions <query>`).
   */
  initialQuery?: string
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
  /** Lowercased value+label+description per item, rebuilt on setItems. */
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

  /** Reserve the list chrome before deriving the item count. */
  private recomputeVisibleBudget(): void {
    const prefix = (this.options.header === undefined ? 0 : 2) + (this.searchEnabled ? 2 : 0)
    const hint = this.options.showHint === true || this.searchEnabled ? 2 : 0
    const indicator = this.filteredItems.length > 1 ? 1 : 0
    const group = this.filteredItems.some(item => item.group !== undefined) ? 1 : 0
    const budget = this.maxRows === Number.POSITIVE_INFINITY
      ? this.configuredMaxVisible
      : this.maxRows - prefix - hint - indicator - group
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
    const push = (line: string, hit: PickerMouseHit): void => {
      lines.push(line)
      hits.push(hit)
    }

    if (this.options.header !== undefined) {
      const countSuffix = this.searchEnabled ? `  ${this.filteredItems.length}/${this.items.length}` : ''
      const headerText = truncateToWidth(`${this.options.header}${countSuffix}`, width, '')
      push((this.theme.groupHeader ?? this.theme.description)(headerText), { kind: 'inert' })
      push('', { kind: 'inert' })
    }

    if (this.searchEnabled && this.searchInput) {
      const searchLine = this.searchInput.render(width)[0] ?? ''
      push(searchLine, { kind: 'search', width })
      push('', { kind: 'inert' })
    }

    // If no items match filter, show message
    if (this.filteredItems.length === 0) {
      push(this.theme.noMatch(this.options.noMatchText ?? '  No matching commands'), { kind: 'inert' })
      if (this.options.showHint === true || this.searchEnabled) this.addHintLine(lines, hits, width)
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
    // selection-centered) until the whole list fits; the hint is the
    // non-negotiable tail (setMaxRows contract). Only the local
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
      push(window.lines[index]!, window.hits[index]!)
    }
    if (showHint) this.addHintLine(lines, hits, width)
    if (Number.isFinite(this.maxRows) && lines.length > this.maxRows) {
      // Degenerate tiny grants: keep the tail (the hint plus as many
      // trailing rows as fit) instead of letting the compositor slice
      // the hint away. The hit map is sliced identically.
      const sliced = lines.slice(lines.length - this.maxRows)
      this.hitMap = hits.slice(hits.length - this.maxRows)
      this.lastRenderWidth = width
      return sliced
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
  ): { lines: string[]; hits: PickerMouseHit[] } {
    const lines: string[] = []
    const hits: PickerMouseHit[] = []

    // Calculate visible range with scrolling
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(visibleCount / 2), this.filteredItems.length - visibleCount),
    )
    const endIndex = Math.min(startIndex + visibleCount, this.filteredItems.length)

    // Group counts over the full (filtered) sequence, so a header inside
    // the visible window can show how many items its group holds.
    const groupCounts = new Map<string, number>()
    for (const item of this.filteredItems) {
      if (item.group === undefined) continue
      groupCounts.set(item.group, (groupCounts.get(item.group) ?? 0) + 1)
    }

    // Render visible items, emitting a header row whenever the group of
    // the next item differs from the previous one (ungrouped items form
    // an implicit anonymous group so groups do not bleed across them).
    let lastGroup: string | undefined = undefined
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i]
      if (!item) continue

      const group = item.group ?? ''
      if (group !== lastGroup) {
        if (group !== '') {
          const count = groupCounts.get(group) ?? 0
          const headerText = truncateToWidth(`  ${group} · ${count}`, width, '')
          lines.push((this.theme.groupHeader ?? this.theme.description)(headerText))
          hits.push({ kind: 'inert' })
        }
        lastGroup = group
      }

      const isSelected = i === this.selectedIndex
      const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined
      lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth))
      hits.push({ kind: 'item', value: item.value, index: i })
    }

    // Add scroll indicators if needed
    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`
      // Truncate if too long for terminal
      lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, '')))
      hits.push({ kind: 'inert' })
    }

    return { lines, hits }
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
    // Any other key edits the search box when search is enabled
    else if (this.searchEnabled && this.searchInput) {
      this.searchInput.handleInput(keyData)
      this.applyFilter(this.searchInput.getValue())
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
          ? `${item.value}\n${item.label}\n${item.description ?? ''}`.toLowerCase().includes(needle)
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

  /** Lowercased value+label+description per item, for fast filtering. */
  private buildSearchTexts(items: SearchablePickerItem[]): Map<SearchablePickerItem, string> {
    return new Map(items.map(item => [
      item,
      `${item.value}\n${item.label}\n${item.description ?? ''}`.toLowerCase(),
    ]))
  }

  private addHintLine(lines: string[], hits: PickerMouseHit[], width: number): void {
    const hint = this.searchEnabled
      ? 'type to filter · ↑↓ navigate · enter select · esc close'
      : '↑↓ navigate · enter select · esc close'
    lines.push('')
    hits.push({ kind: 'inert' })
    lines.push(this.theme.scrollInfo(truncateToWidth(`  ${hint}`, width - 2, '')))
    hits.push({ kind: 'inert' })
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
    return item.label || item.value
  }

  private notifySelectionChange(): void {
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
