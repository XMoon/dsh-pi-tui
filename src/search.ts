/**
 * The transcript-search overlay component: a one-line query input with a
 * live match counter. Mirrors the fork's alt-screen search component shape
 * (Component + Focusable) so the main-screen overlay host can mount it; the
 * search itself runs in the runner against the folded transcript, not against
 * rendered lines (the terminal scrollback is not addressable programmatically).
 * @module @xmoon76/dsh-pi-tui/search
 */

import { Input } from '@xmoon76/pi-tui'
import type { Component, Focusable } from '@xmoon76/pi-tui'
import { visibleWidth } from '@xmoon76/pi-tui'

/** One-line search input with a "Find transcript" title and N/M counter. */
export class TranscriptSearchComponent implements Component, Focusable {
  private readonly input = new Input()
  private readonly onQueryChange: (query: string) => void
  private resultCount = 0
  private resultIndex = -1
  private _focused = false

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

  invalidate(): void {
    this.input.invalidate()
  }

  render(width: number): string[] {
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
    return [`\x1b[7m${title}${padding}\x1b[27m`, ...this.input.render(safeWidth)]
  }
}
