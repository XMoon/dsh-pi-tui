/**
 * The shared Action Bar row (design language v1 §7.2).
 *
 * A bar is a row of segments; when the row does not fit, whole segments are
 * dropped by ascending `priority` (never a partial word), a segment that
 * declares a `short` form is compacted first, and a single remaining segment is
 * the only thing ever truncated.
 *
 * This was the Job workspace's private implementation
 * (`job-inspector-panel.ts`); it is extracted here because the Settings
 * workspace needs exactly the same row (design language rollout PR1). The
 * helper is pure and stateless — it copies the caller's segments, reads no
 * palette, and returns an unpainted string for the caller to paint.
 * @module @xmoon76/dsh-pi-tui/tui/presentation/action-bar
 */

import { truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'

/** One Action Bar segment: `short` is the compaction this segment accepts when
 *  the row is tight, `priority` the order it is DROPPED in (lower goes first). */
export interface ActionBarSegment {
  text: string
  priority: number
  short?: string
}

/** The separator between surviving segments. The design language freezes ` · `
 *  (v1 §4.2, decision D4) and this constant is the ONE place it lives: the
 *  Settings PR flipped it for both surfaces at once, because they share the row.
 *  There is no per-caller separator option — one family, one separator. */
export const ACTION_BAR_SEPARATOR = ' · '

/**
 * Lay out one Action Bar row: compact shortenable segments first, then drop the
 * lowest-priority segment until the row fits (never the last one).
 * @param segments - the segments in DISPLAY order; each is copied.
 * @param width - the terminal cells available to the row.
 * @returns the unpainted row, padded to the exact width when truncated.
 */
export function renderActionBarRow(segments: readonly ActionBarSegment[], width: number): string {
  const list = segments.map(segment => ({ ...segment }))
  for (;;) {
    const line = list.map(segment => segment.text).join(ACTION_BAR_SEPARATOR)
    if (visibleWidth(line) <= width || list.length <= 1) {
      return truncateToWidth(line, width, '…', true)
    }
    const shortenable = list.find(segment => segment.short !== undefined && segment.text !== segment.short)
    if (shortenable !== undefined) {
      shortenable.text = shortenable.short!
      continue
    }
    let lowest = 0
    for (let index = 1; index < list.length; index += 1) {
      if (list[index]!.priority < list[lowest]!.priority) lowest = index
    }
    list.splice(lowest, 1)
  }
}
