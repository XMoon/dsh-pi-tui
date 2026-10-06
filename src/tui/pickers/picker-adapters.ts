/**
 * Picker presentation adapters (TS4 plan §21): `MarqueeFilterAdapter` restarts
 * the selected-row marquee when a search-query edit re-filters the list, and
 * `ExternalSearchList` composes a caller-owned search Input with a picker that
 * renders without its internal substring filter.
 *
 * Moved verbatim out of `tui-app.ts`; the global keybinding ownership stays
 * outside (they only consume `getKeybindings()`).
 * @module @xmoon76/dsh-pi-tui/tui/pickers/picker-adapters
 */

import { Input, dispatchMouseEvent, getKeybindings } from '@xmoon76/pi-tui'
import type { Component, Focusable, TuiMouseDispatchResult, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import type { SearchablePicker } from './searchable-picker.ts'

/**
 * A paper-thin Component adapter over a picker's SearchablePicker (review
 * P2): the picker only fires onSelectionChange for ↑↓/PageUp/PageDown —
 * typing into the search box re-filters WITHOUT a selection change, so a
 * long selected label would keep marqueeing mid-cycle inside the new
 * filter instead of restarting from a fresh anchor. The adapter intercepts
 * handleInput, detects a search-query change (the picker's getFilter() is
 * the truth — a query edit is the ONLY input that moves it), and resets
 * the marquee. The Host picker itself is untouched; this wraps it on the
 * consumer side.
 */
export class MarqueeFilterAdapter implements Component, Focusable {
  private readonly list: SearchablePicker
  private readonly onFilterChange: () => void
  private _focused = false

  constructor(list: SearchablePicker, onFilterChange: () => void) {
    this.list = list
    this.onFilterChange = onFilterChange
  }

  /** Focusable (moved from fork divergence X042): forward to the wrapped
   * picker so its search Input emits the hardware CURSOR_MARKER (IME
   * positioning). */
  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.list.focused = value
  }

  invalidate(): void {
    this.list.invalidate()
  }

  handleInput(data: string): void {
    const before = this.list.getFilter()
    this.list.handleInput(data)
    // A search-query edit re-filters the list: the selected row (whatever
    // it is now) must restart its marquee cycle from a fresh anchor. Keys
    // that do not move the query (arrows, Enter, Esc, Tab) leave it
    // untouched — their selection moves are handled by onSelectionChange.
    if (this.list.getFilter() !== before) {
      this.onFilterChange()
    }
  }

  /** Transparent mouse forwarding (mouse parity): the picker owns the hit
   * map; the gesture/focus target is rewritten to THIS adapter — the
   * picker is a private field not reachable from the mounted tree, so
   * X018 gesture liveness tracks the mounted unit. */
  handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
    const result = this.list.handleMouse?.(event)
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

  render(width: number): string[] {
    return this.list.render(width)
  }
}

/**
 * The externally-filtered search composite (review P1): the caller's items
 * are the membership authority — the picker renders WITHOUT its internal
 * substring filter (enableSearch: false), and a separate search Input
 * feeds `onFilterChange` so the caller re-filters the rows. The composite
 * routes navigation/confirm/cancel keys to the picker and every other key
 * to the search Input (the picker's keybinding vocabulary).
 */
export class ExternalSearchList implements Component, Focusable {
  private readonly input: Input
  private readonly list: SearchablePicker
  private readonly onFilterChange: (query: string) => void
  private _focused = false

  constructor(input: Input, list: SearchablePicker, onFilterChange: (query: string) => void) {
    this.input = input
    this.list = list
    this.onFilterChange = onFilterChange
  }

  /** Focusable (moved from fork divergence X042): forward to the search
   * Input so it emits the hardware CURSOR_MARKER (IME positioning). */
  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.input.focused = value
  }

  invalidate(): void {
    this.input.invalidate()
    this.list.invalidate()
  }

  handleInput(data: string): void {
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.up')
      || kb.matches(data, 'tui.select.down')
      || kb.matches(data, 'tui.select.pageUp')
      || kb.matches(data, 'tui.select.pageDown')
      || kb.matches(data, 'tui.select.confirm')
      || kb.matches(data, 'tui.select.cancel')) {
      this.list.handleInput(data)
      return
    }
    const before = this.input.getValue()
    this.input.handleInput(data)
    if (this.input.getValue() !== before) this.onFilterChange(this.input.getValue())
  }

  /** Transparent mouse forwarding (mouse parity): row 0 is the external
   * search Input, row 1 is the blank spacer, rows 2+ are the picker's
   * own hit-mapped rows (translated by the spacer). Both children are
   * private fields, so the gesture/focus target is rewritten to THIS
   * composite — X018 gesture liveness tracks the mounted unit. */
  handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
    const result = event.y === 0
      ? dispatchMouseEvent(this.input, { ...event, y: 0 })
      : event.y >= 2
        ? this.list.handleMouse?.({ ...event, y: event.y - 2 })
        : undefined
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

  render(width: number): string[] {
    return [...this.input.render(width), '', ...this.list.render(width)]
  }
}
