/**
 * Shared frame assertions for the design-language governance tests
 * (`docs/tui-design-language.md` §8 responsive ladder + §11.3.2 frame
 * invariants).
 *
 * These are deliberately four narrow helpers over a REAL painted frame: the
 * caller reads the rows it already paints and passes the `VirtualTerminal`'s
 * own cell-colour read-back (`getCellFgRgb`) as `readColor`. There is no
 * framework, no snapshot and no second terminal harness here — the same
 * `VirtualTerminal` each visual suite already owns is the witness.
 *
 * @module @xmoon76/dsh-pi-tui/test/support/design-language-frames
 */

import assert from 'node:assert/strict'
import { visibleWidth } from '@xmoon76/pi-tui'

/** The painted facts one invariant check reads: the plain (ANSI-stripped) rows
 *  of one frame, the truecolor foreground of one cell, and the palette's
 *  `primary` ink the active device is painted with. */
export interface PaintedFrame {
  readonly rows: readonly string[]
  readonly readColor: (row: number, col: number) => number | undefined
  readonly primaryRgb: number
}

/** A printable frame for failure messages (no assertion swallows the frame). */
const frameText = (rows: readonly string[]): string =>
  rows.map((line, index) => `${String(index).padStart(2)}| ${line}`).join('\n')

/**
 * §8 invariant: "The action bar is the physical last row and is never budgeted
 * away." Asserts the last physical row carries the expected bar text, is really
 * painted (its first cell has an RGB foreground), and that no blank trailing row
 * pushed the bar up.
 */
export function assertBarIsLastRow(
  rows: readonly string[],
  readColor: (row: number, col: number) => number | undefined,
  expectedBarText: string,
): void {
  assert.ok(rows.length > 0, 'a frame must paint at least the pinned action bar')
  const last = rows.length - 1
  const bar = rows[last]!
  assert.notEqual(bar.trim(), '', `the physical last row must be the action bar, not a blank row:\n${frameText(rows)}`)
  assert.ok(bar.includes(expectedBarText),
    `the physical last row must carry ${JSON.stringify(expectedBarText)}:\n${frameText(rows)}`)
  assert.notEqual(readColor(last, 0), undefined,
    `the action bar's first cell must be really painted (not a phantom plain row):\n${frameText(rows)}`)
}

/**
 * §8 invariant: "A body row is reserved from 3 terminal rows up." From three
 * terminal rows on, at least one of the caller's real body rows must be painted
 * (the caller supplies the indexes it measured from the frame).
 */
export function assertBodyFloor(rows: readonly string[], bodyRowIndexes: readonly number[]): void {
  for (const index of bodyRowIndexes) {
    assert.ok(index >= 0 && index < rows.length,
      `body row ${index} must be a painted physical row:\n${frameText(rows)}`)
    assert.ok(index < rows.length - 1,
      `body row ${index} must sit above the pinned action bar:\n${frameText(rows)}`)
  }
  if (rows.length >= 3) {
    assert.ok(bodyRowIndexes.length >= 1,
      `at least one body row must be painted from 3 terminal rows up:\n${frameText(rows)}`)
  }
}

/**
 * §7.2/§8 step 7: the bar drops whole segments, never a partial word. `…` is
 * allowed only on the single last-resort segment; while more than one segment is
 * painted (counted by the caller's ` · ` separator) the row must contain none.
 */
export function assertNoHalfSegmentInBar(
  rows: readonly string[],
  barRow: number,
  separator: string,
): void {
  const bar = rows[barRow]
  assert.notEqual(bar, undefined, `row ${barRow} must be painted:\n${frameText(rows)}`)
  const segments = bar!.split(separator).length
  if (segments > 1) {
    assert.ok(!bar!.includes('…'),
      `a multi-segment action bar (${segments} segments) must not truncate mid-hint:\n${frameText(rows)}`)
  }
}

/**
 * §11.3.2/§4.5: "at most one bracketed active label per painted frame". Derives
 * every bracketed token from the plain rows and inspects its FIRST cell's
 * foreground: at most one ACTIVE-DEVICE token may wear `primary`.
 *
 * §4.5 tells the bracket classes apart by shape, not position: an active device
 * is a Title Case `[Label]` (`[Output]`, `[Details]`, `[Categories (3)]`). A key
 * badge (`[C]`, also `primary` per §7.1), an ALL-CAPS machine marker
 * (`[GAP]`), a lowercase state chip (`[current]`) and a grouped badge are NOT
 * active devices and are excluded by {@link isActiveDeviceToken} before the
 * colour test. This matters in a real frame: Settings paints `Copy value [C]`
 * beside `[Categories (3)]`, and both are `primary` — only the label is the
 * active signal.
 */
export function assertOneActiveDevice(frame: PaintedFrame): void {
  const actives: string[] = []
  const seen: string[] = []
  const tokenPattern = /\[[^\]\n]+\]/gu
  for (const [rowIndex, row] of frame.rows.entries()) {
    for (const match of row.matchAll(tokenPattern)) {
      const token = match[0]
      if (!isActiveDeviceToken(token)) continue
      const col = visibleWidth(row.slice(0, match.index))
      const ink = frame.readColor(rowIndex, col)
      seen.push(`${token}@${rowIndex}:${col}=${ink === undefined ? 'none' : ink.toString(16)}`)
      if (ink !== undefined && ink === frame.primaryRgb) actives.push(`${token}@${rowIndex}:${col}`)
    }
  }
  assert.ok(actives.length <= 1,
    `at most ONE bracketed active label may be painted primary, found ${actives.length} (${actives.join(', ')}); active-device tokens: ${seen.join(', ')}\n${frameText(frame.rows)}`)
}

/** §4.5: the active device's shape is Title Case `[Label]`. */
function isActiveDeviceToken(token: string): boolean {
  return /^\[[A-Z][a-z]/u.test(token)
}
