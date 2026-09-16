/**
 * The compact Thinking preview's horizontal window (dsh-web running
 * collapsed-reasoning parity).
 *
 * The Web keeps a collapsed reasoning row pinned to its right edge
 * (`scrollLeft = scrollWidth - clientWidth`) on every real text update, so
 * the LATEST token is always visible; a terminal does not need DOM scroll
 * state — the visible column window is recomputed per render instead.
 *
 * Ownership is "Thinking compact + running", never "Focus mode is X": the
 * follow-end applies while reasoning deltas actually stream. A settled row
 * keeps the ordinary head truncation (reading a finished thought starts at
 * its beginning), and the full-expanded body is never clipped at all.
 *
 * Pure and presentation-only: no marquee/timer, no Host import. The actual
 * movement is driven solely by the provider's reasoning deltas.
 * @module @xmoon76/dsh-pi-tui/thinking-preview
 */

import { sliceByColumn, visibleWidth } from '@xmoon76/pi-tui'

/**
 * The right-edge window of `line` that fits `budget` visible columns: the
 * whole line when it already fits, otherwise its last `budget` columns with
 * the overflow dropped from the LEFT.
 *
 * `sliceByColumn` is ANSI/wide-char/grapheme aware, so a CJK or emoji
 * grapheme is never split across the window's left boundary. Never use
 * `string.slice(-width)` (UTF-16 code units) here.
 * @param line - one logical reasoning line (no line breaks).
 * @param budget - the visible column budget of the body (excluding any
 *   fixed `Think:` / indent prefix).
 * @returns at most `budget` visible columns, ending at the line's tail.
 */
export function thinkingPreviewTail(line: string, budget: number): string {
  if (budget <= 0) return ''
  const total = visibleWidth(line)
  if (total <= budget) return line
  return sliceByColumn(line, Math.max(0, total - budget), budget, true)
}
