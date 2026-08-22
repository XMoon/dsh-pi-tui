/**
 * Indeterminate progress-bar frames for the working row's animated suffix
 * (compaction progress): a solid block slides back and forth across a
 * track, ping-pong style — never a fake percentage. Pure and dependency
 * free so it unit-tests trivially.
 * @module @xmoon76/dsh-pi-tui/progress
 */

/** The frames of an indeterminate progress bar: a `blockWidth`-wide solid
 * block slides across a `width`-wide track, ping-ponging at both ends
 * (0..max, then max..0) so the motion never jumps from the tail back to
 * the head. Each frame is the bracketed bar, e.g. `[███░░░░░░░░░]` for
 * width 12 / block 3 — the same visual weight as the footer context bar.
 * @param width - the track width in cells (default 12).
 * @param blockWidth - the sliding block width in cells (default 3).
 * @returns the animation frames, oldest first.
 */
export function indeterminateProgressFrames(width = 12, blockWidth = 3): string[] {
  const track = Math.max(1, Math.floor(width))
  const block = Math.min(Math.max(1, Math.floor(blockWidth)), track)
  const maxStart = track - block
  const positions: number[] = []
  for (let start = 0; start <= maxStart; start += 1) positions.push(start)
  for (let start = maxStart - 1; start >= 0; start -= 1) positions.push(start)
  return positions.map(start => {
    const cells: string[] = []
    for (let index = 0; index < track; index += 1) {
      cells.push(index >= start && index < start + block ? '█' : '░')
    }
    return `[${cells.join('')}]`
  })
}
