/**
 * Rewind picker-row projection (TS8-E): build the mounted surface's picker
 * rows from the official whole-log `turnOutline` projection.
 *
 * This is an APPLICATION-presentation projection consumed by the mounted
 * surface owner (`app/surface/application-events.ts`); the concrete TUI picker
 * only consumes the plain `{value,label}` rows. The candidate-based picker
 * ITEM (a PiTui `PickerItem`) stays in `tui/pickers/rewind.ts`, and the neutral
 * candidate fold in `domain/session/rewind.ts`.
 * @module @xmoon76/dsh-pi-tui/app/surface/rewind-presentation
 */

/**
 * Build picker rows from the official whole-log `turnOutline` projection
 * (M3-4 PR4 §4.2): every STARTED turn is listed — old turns outside the
 * current presentation event window included — using the projection's own
 * bounded previews. The row value is the turn's `turn/start` seq (the
 * `loadThrough` jump target); the first outline entry is EXCLUDED exactly
 * like the full-log fold (a first human turn has no predecessor boundary to
 * fork at).
 * @param outline - the official turnOutline projection entries (ascending).
 * @returns the newest-first picker rows.
 */
export function rewindOutlineRows(outline: readonly {
  readonly turn: number
  readonly seq: number
  readonly prompt: string
  readonly response: string
}[]): Array<{ readonly value: string; readonly label: string }> {
  const rows: Array<{ readonly value: string; readonly label: string }> = []
  for (let index = outline.length - 1; index >= 1; index -= 1) {
    const entry = outline[index]!
    const prompt = entry.prompt === '' ? '(no text prompt)' : entry.prompt
    rows.push({ value: String(entry.seq), label: `turn ${entry.turn} · ${prompt}` })
  }
  return rows
}
