/** Display-only abbreviation for a picker row that paints a NAME in its label.
 *
 * The vendored `SettingsList` clips a label to its column keeping the HEAD, so a
 * name longer than that column loses exactly the part that tells two rows apart.
 * Keeping only the head collides for two names that share a prefix; keeping only
 * the tail collides for two names that share a suffix — so a long name keeps BOTH
 * ends around one `…`. Iteration is by CODE POINT, so an astral character is
 * measured as one character, never as two UTF-16 surrogate halves.
 *
 * The CALLER owns the `limit` (it is the row's effective label column) and the
 * row's own `description`, which must lead with the complete name for the
 * selected row: this function never hides an identity, it only abbreviates a
 * label. Nothing here touches a row's `id`, `values` or write path.
 * @module @xmoon76/dsh-pi-tui/tui/pickers/name-label
 */
import { visibleWidth } from '@xmoon76/pi-tui'

export function abbreviateName(name: string, limit: number): string {
  if (visibleWidth(name) <= limit) return name
  const chars = Array.from(name)
  // One cell is the ellipsis; the rest is split between the two ends, the head
  // taking the extra cell so an odd budget stays deterministic.
  const cells = limit - 1
  const headCells = Math.ceil(cells / 2)
  const tailCells = cells - headCells
  let head = ''
  let used = 0
  for (const char of chars) {
    const width = visibleWidth(char)
    if (used + width > headCells) break
    head += char
    used += width
  }
  let tail = ''
  used = 0
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!
    const width = visibleWidth(char)
    if (used + width > tailCells) break
    tail = char + tail
    used += width
  }
  return `${head}\u2026${tail}`
}
