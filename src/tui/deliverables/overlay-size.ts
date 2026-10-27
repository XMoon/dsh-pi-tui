/**
 * The ONE geometry authority of the Delivered files overlay (Delivered files
 * PR A): a centered percentage window instead of the old wide-terminal
 * near-fullscreen exception.
 *
 * The formula is the Owner-frozen contract:
 *
 * ```
 * width = C < 80 ? C : min(120, max(72, floor(C * 0.80)))
 * maxHeight = R < 20 ? max(1, R - 2) : min(38, max(1, floor(R * 0.75)))
 * margin = undefined (center anchor default)
 * ```
 *
 * The host resolves it for the overlay options AND for the responsive frame
 * from THIS function, so the painted outer frame and the granted content rows
 * can never come from two different sizes. All inputs are first reduced to
 * non-negative finite integers; the result is always usable (width ≥ 1,
 * maxHeight ≥ 1) so a degenerate terminal still renders a frame.
 * @module @xmoon76/dsh-pi-tui/tui/deliverables/overlay-size
 */

/** The outer frame width and the outer height cap of the one overlay. */
export interface DeliveredFilesOverlayGeometry {
  readonly width: number
  readonly maxHeight: number
}

/** The formula's maximum window: the host overlay CANVAS the responsive frame
 *  is given. The fork re-clamps these numeric options to the live terminal on
 *  every frame, and the frame paints the formula's live result centered inside
 *  the canvas. Using the ceiling (not the current size) is what lets a window
 *  resize grow the frame without remounting the panel. */
export const DELIVERED_FILES_OVERLAY_MAX_WIDTH = 120
export const DELIVERED_FILES_OVERLAY_MAX_HEIGHT = 38

/** Reduce one terminal metric to a non-negative finite integer. */
function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

/** The host canvas for the ONE overlay: the formula's maximum window. */
export function deliveredFilesOverlayCanvas(): DeliveredFilesOverlayGeometry {
  return { width: DELIVERED_FILES_OVERLAY_MAX_WIDTH, maxHeight: DELIVERED_FILES_OVERLAY_MAX_HEIGHT }
}

/** Resolve the Delivered files overlay geometry for a terminal size. */
export function deliveredFilesOverlayGeometry(columns: number, rows: number): DeliveredFilesOverlayGeometry {
  const c = nonNegativeInteger(columns)
  const r = nonNegativeInteger(rows)
  const width = c < 80 ? c : Math.min(DELIVERED_FILES_OVERLAY_MAX_WIDTH, Math.max(72, Math.floor(c * 0.80)))
  const maxHeight = r < 20
    ? Math.max(1, r - 2)
    : Math.min(DELIVERED_FILES_OVERLAY_MAX_HEIGHT, Math.max(1, Math.floor(r * 0.75)))
  return { width: Math.max(1, width), maxHeight }
}
