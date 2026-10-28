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
import { chartDisplayTitle, chartTextRows, type ChartFact } from '../../../domain/visual/chart.ts'
import { sanitizeDisplayText } from '../../presentation/terminal-text.ts'

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
    // External label/title/unit bytes are display material. The durable fact
    // and the copy/export authorities stay raw; this projection sanitizes
    // BEFORE the wrap/paint so an OSC/CSI/C1 sequence can never reach the tty.
    const pushRow = (row: string): void => {
      // A long label wraps instead of clipping the exact value at its tail.
      for (const wrapped of wrapTextWithAnsi(sanitizeDisplayText(row), bodyWidth)) {
        rows.push(truncateToWidth(this.paint(`  ${wrapped}`), safeWidth, ''))
      }
    }
    // The FINAL fact title, not the original call summary: a value replacement
    // may legitimately change the committed title.
    pushRow(chartDisplayTitle(this.fact))
    for (const row of chartTextRows(this.fact, bodyWidth)) pushRow(row)
    this.cached.set(safeWidth, rows)
    return rows
  }
}
