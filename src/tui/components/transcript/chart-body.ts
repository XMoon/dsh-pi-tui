/**
 * The PiTui chart body: width-aware ASCII bars (or a sparkline) plus every
 * exact label and value. The numbers are the contract; the glyphs are only an
 * enhancement and the plain label/value list is the fallback at narrow widths.
 *
 * The rows are derived at render(width) time (never baked into the transcript
 * message cache), so a resize reflows the card without rebuilding it. The
 * machine line that authorized this drawing is never shown here.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/chart-body
 */

import { truncateToWidth, wrapTextWithAnsi, type Component } from '@xmoon76/pi-tui'
import { chartTextRows, type ChartFact } from '../../../domain/visual/chart.ts'

/** Paint function for the dimmed body rows (the tool-card body convention). */
export type ChartBodyPaint = (text: string) => string

/** Render one chart fact as a card body. */
export class ChartBody implements Component {
  private readonly fact: ChartFact
  private readonly paint: ChartBodyPaint
  private readonly cached = new Map<number, string[]>()

  constructor(fact: ChartFact, paint: ChartBodyPaint = text => text) {
    this.fact = fact
    this.paint = paint
  }

  /** Drop the per-width cache (theme/invalidate contract). */
  invalidate(): void {
    this.cached.clear()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const cached = this.cached.get(safeWidth)
    if (cached !== undefined) return cached
    const bodyWidth = Math.max(1, safeWidth - 2)
    const rows: string[] = []
    for (const row of chartTextRows(this.fact, bodyWidth)) {
      // A long label wraps instead of clipping the exact value at its tail.
      for (const wrapped of wrapTextWithAnsi(row, bodyWidth)) {
        rows.push(truncateToWidth(this.paint(`  ${wrapped}`), safeWidth, ''))
      }
    }
    this.cached.set(safeWidth, rows)
    return rows
  }
}
