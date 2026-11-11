/**
 * The ink roles of a clickable Action Bar segment (design language §7.1).
 *
 * The row itself is owned by {@link layoutActionBarRow}; this module owns only
 * HOW a complete segment is painted once the row decided it is fully visible.
 * The Fullscreen dense Action Bars (Question/Task Center, Job, Output Viewer,
 * Session, Settings and its hosted Plugin/Footer/Keybindings/Web pages) are
 * the Owner-scoped exception to Role 14 `primary`: the primary forward/commit
 * verb paints `text`, a secondary navigation verb (Back/Close/Cancel/Hide/
 * Clear) paints `textDim`, and a `[Key]` cap paints `textMuted`. The visible
 * width never changes, so the caller's unpainted layout span stays the ONE
 * hit geometry source.
 * @module @xmoon76/dsh-pi-tui/tui/presentation/action-ink
 */

import { color } from '../theme/runtime.ts'

/** The brightness role of one clickable segment. */
export type ActionInkRole = 'primary' | 'secondary'

/** Paint one COMPLETE segment: the verb carries the role ink and a trailing
 *  `[Key]` cap is muted. Text without a cap has no key to mute. */
export function paintActionSpan(text: string, role: ActionInkRole): string {
  const ink = role === 'primary' ? color.text : color.textDim
  const match = /^(.*) \[([^\]]+)\]$/.exec(text)
  return match === null ? ink(text) : `${ink(match[1]!)}${color.textMuted(` [${match[2]}]`)}`
}
