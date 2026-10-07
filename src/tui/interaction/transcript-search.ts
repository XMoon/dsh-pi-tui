/**
 * The transcript-search overlay component: a one-line query input with a
 * live match counter. Mirrors the fork's alt-screen search component shape
 * (Component + Focusable) so the main-screen overlay host can mount it; the
 * search itself runs in the runner against the folded transcript, not against
 * rendered lines (the terminal scrollback is not addressable programmatically).
 * @module @xmoon76/dsh-pi-tui/tui/interaction/transcript-search
 */

import { Input, dispatchMouseEvent, truncateToWidth } from '@xmoon76/pi-tui'
import type { Component, Focusable, TuiMouseDispatchResult, TuiMouseEvent } from '@xmoon76/pi-tui'
import { visibleWidth } from '@xmoon76/pi-tui'
import { color } from '../../tui/theme/runtime.ts'

import { componentKeymap } from '../keybindings/component-keymap.ts'

/** The three non-configurable search-overlay actions (scope 'search',
 * `configurable: false`). */
type SearchHintAction =
  | 'app.transcript.search.next'
  | 'app.transcript.search.previous'
  | 'app.transcript.search.close'

/** One keymap-derived label in the overlay's compact glyph style: the base key
 * becomes its glyph and a modified key keeps the modifier glyph (`Enter` ->
 * `↵`, `Shift+Enter` -> `⇧↵`, `Esc / Ctrl+C` -> `esc/ctrl+c`). The labels come
 * from the keymap's own definitions — never a hand-written key literal (the
 * keybinding gate) — so the hint cannot lie about a binding. */
const compactKeyHint = (action: SearchHintAction): string => {
  const label = componentKeymap.keyHint(action).toLowerCase().replace('shift', '⇧').replace('enter', '↵')
  // A modified key collapses `⇧+↵` to `⇧↵`; a multi-key list keeps its `+`
  // inside each key id and joins with `/` (`esc / ctrl+c` -> `esc/ctrl+c`).
  return label.includes('⇧') ? label.replace('+', '') : label.replace(' / ', '/')
}

/** The one-line navigation hint under the search input: Enter/Shift+Enter step
 * through matches, Esc/Ctrl+C close. A remap of the configurable search TOGGLE
 * is deliberately not shown. */
const SEARCH_HINT = `${compactKeyHint('app.transcript.search.next')} next · ${compactKeyHint('app.transcript.search.previous')} prev · ${compactKeyHint('app.transcript.search.close')} close`

/** One-line search input with a "Find transcript" title and N/M counter. */
export class TranscriptSearchComponent implements Component, Focusable {
  private readonly input = new Input()
  private readonly onQueryChange: (query: string) => void
  private resultCount = 0
  private resultIndex = -1
  private _focused = false
  /** Render width from the last paint (stale-geometry guard). */
  private lastRenderWidth = 0

  constructor(onQueryChange: (query: string) => void) {
    this.onQueryChange = onQueryChange
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.input.focused = value
  }

  /** Publish the current match position (1-based index, total) for the header. */
  setResult(index: number, count: number): void {
    this.resultIndex = index
    this.resultCount = count
  }

  handleInput(data: string): void {
    const previous = this.input.getValue()
    this.input.handleInput(data)
    const query = this.input.getValue()
    if (query !== previous) this.onQueryChange(query)
  }

  /**
   * Mouse parity (mirrors vendor X049 for the alt-screen search): the
   * query Input row (row 1, the Input's own render at full width)
   * click-positions the private Input; title and hint rows stay inert.
   * The dispatch target/focus are rewritten to THIS component: the
   * private Input is not mounted in the TUI tree (isMouseTargetLive
   * would clear the gesture on release), so the mounted wrapper must
   * stay the gesture/focus owner.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    if (event.width !== this.lastRenderWidth || event.y !== 1) return undefined
    if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) return undefined
    const result = dispatchMouseEvent(this.input, { ...event, y: 0, height: 1 })
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

  invalidate(): void {
    this.input.invalidate()
  }

  render(width: number): string[] {
    this.lastRenderWidth = width
    const safeWidth = Math.max(1, width)
    const label = ' Find transcript'
    const query = this.input.getValue()
    const status = !query
      ? ''
      : this.resultCount === 0
        ? 'No matches '
        : `${this.resultIndex + 1}/${this.resultCount} `
    const labelWidth = visibleWidth(label)
    const statusWidth = visibleWidth(status)
    const gap = ' '.repeat(Math.max(1, safeWidth - labelWidth - statusWidth))
    const title = `${label}${gap}${status}`.slice(0, Math.max(1, safeWidth))
    const padding = ' '.repeat(Math.max(0, safeWidth - visibleWidth(title)))
    const hint = color.textDim(truncateToWidth(SEARCH_HINT, safeWidth, '…'))
    return [`\x1b[7m${title}${padding}\x1b[27m`, ...this.input.render(safeWidth), hint]
  }
}
