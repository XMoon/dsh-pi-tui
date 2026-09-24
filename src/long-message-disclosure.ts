/**
 * The ONE long-message disclosure geometry shared by the durable/pending user
 * bubble and the `relay` Context row.
 *
 * Both consumers decide and slice on the SAME visual rows the current width
 * produces (never logical lines), so a long line that wraps behaves
 * identically everywhere and an expanded body never duplicates head/tail rows.
 * @module @xmoon76/dsh-pi-tui/long-message-disclosure
 */

/** The visual-row geometry of one long-message fold. */
export interface LongMessageDisclosureGeometry {
  /** Fold only when the wrapped body exceeds this many visual rows. */
  readonly thresholdRows: number
  /** Visual rows kept from the start while collapsed. */
  readonly headRows: number
  /** Visual rows kept from the end while collapsed (a message's conclusion). */
  readonly tailRows: number
}

/** The sliced window of one long-message body. */
export interface LongMessageDisclosureWindow {
  /** The rows to render, in order (head, marker, tail when compacted). */
  readonly rows: readonly string[]
  /** Whether the body exceeds the threshold at all. */
  readonly long: boolean
  /** The marker row index when compacted; undefined otherwise. */
  readonly markerRow?: number
  /** Visual rows hidden by the marker (0 when nothing is hidden). */
  readonly hiddenRows: number
}

/**
 * Slice one already-wrapped message body into its disclosure window.
 *
 * `bodyRows` MUST be the physical rows the renderer will paint at the current
 * width. `marker(hiddenRows)` builds the overflow row (the caller owns its
 * wording and its narrow-width clipping).
 */
export function longMessageDisclosureWindow(
  bodyRows: readonly string[],
  geometry: LongMessageDisclosureGeometry,
  options: { readonly expanded: boolean; readonly marker: (hiddenRows: number) => string },
): LongMessageDisclosureWindow {
  const length = bodyRows.length
  if (length <= geometry.thresholdRows) return { rows: bodyRows, long: false, hiddenRows: 0 }
  if (options.expanded) return { rows: bodyRows, long: true, hiddenRows: 0 }
  const head = Math.min(geometry.headRows, length)
  const tail = Math.min(geometry.tailRows, Math.max(0, length - head))
  if (head + tail >= length) return { rows: bodyRows, long: true, hiddenRows: 0 }
  const hiddenRows = length - head - tail
  return {
    rows: [...bodyRows.slice(0, head), options.marker(hiddenRows), ...bodyRows.slice(length - tail)],
    long: true,
    markerRow: head,
    hiddenRows,
  }
}
