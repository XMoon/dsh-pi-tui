/**
 * Shared frame assertions for the design-language governance tests
 * (`docs/architecture/design-language.md` §8 responsive ladder + §11.3.2 frame
 * invariants).
 *
 * These are deliberately four narrow helpers over a REAL painted frame: the
 * caller reads the rows it already paints and passes the `VirtualTerminal`'s
 * own cell-colour read-back (`getCellFgRgb`) as `readColor`. There is no
 * framework, no snapshot and no second terminal harness here — the same
 * `VirtualTerminal` each visual suite already owns is the witness.
 *
 * Every helper takes the surface's OWN chrome facts (which rows, which labels,
 * what real body content looks like) instead of inferring them: a frame's body
 * is Host text that may contain bracket labels and its own colours, and §4.5's
 * other bracket classes are legitimately painted `primary` inside an
 * affordance. Guessing either produces a check that passes on a broken frame
 * or fails on a correct one.
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
 *
 * `firstCell` is the column the bar STARTS at: a two-column frame (the Settings
 * category rail and its content column) paints the bar in the CONTENT column,
 * so its first cell is not column 0.
 */
export function assertBarIsLastRow(
  rows: readonly string[],
  readColor: (row: number, col: number) => number | undefined,
  expectedBarText: string,
  firstCell = 0,
): void {
  assert.ok(rows.length > 0, 'a frame must paint at least the pinned action bar')
  const last = rows.length - 1
  const bar = rows[last]!
  assert.notEqual(bar.trim(), '', `the physical last row must be the action bar, not a blank row:\n${frameText(rows)}`)
  assert.ok(bar.includes(expectedBarText),
    `the physical last row must carry ${JSON.stringify(expectedBarText)}:\n${frameText(rows)}`)
  assert.notEqual(readColor(last, firstCell), undefined,
    `the action bar's first cell must be really painted (not a phantom plain row):\n${frameText(rows)}`)
}

/**
 * §8 invariant: "A body row is reserved from 3 terminal rows up." The caller
 * supplies the rows it predicts are body rows AND its own `isBodyContent`
 * predicate for that surface (`> <item>` for a Settings list, `line NNN` for the
 * Job's retained text). At least one predicted row must carry REAL body content:
 * an index-only check would pass a frame whose body was blanked while its chrome
 * stayed in place — the exact regression this matrix exists to catch.
 */
export function assertBodyFloor(
  rows: readonly string[],
  bodyRowIndexes: readonly number[],
  isBodyContent: (row: string) => boolean,
  surface: string,
): void {
  for (const index of bodyRowIndexes) {
    assert.ok(index >= 0 && index < rows.length,
      `body row ${index} must be a painted physical row:\n${frameText(rows)}`)
    assert.ok(index < rows.length - 1,
      `body row ${index} must sit above the pinned action bar:\n${frameText(rows)}`)
  }
  if (rows.length >= 3) {
    assert.ok(bodyRowIndexes.length >= 1,
      `at least one body row must be painted from 3 terminal rows up:\n${frameText(rows)}`)
    const painted = bodyRowIndexes.filter(index => isBodyContent(rows[index] ?? ''))
    assert.ok(painted.length >= 1,
      `${surface}: the predicted body rows must carry real body content, not just plausible indexes (${bodyRowIndexes.join(', ')}):\n${frameText(rows)}`)
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

/** Where a surface's chrome active device may live and what it is called. */
export interface ActiveDeviceSite {
  /** The physical rows that may carry a CHROME active device. Never a body row:
   *  Host output is not chrome and can contain bracket-labelled text of its own. */
  readonly rows: readonly number[]
  /** The first cells of every active-device label the surface can paint, e.g.
   *  `'[Categories'`/`'[Rows'`/`'[Details]'` or `'[Output]'`/`'[Command]'`. A
   *  PREFIX, so a counted label (`[Categories (3)]`) needs no count baked in.
   *  §4.5's other bracket classes are deliberately absent: a key badge
   *  (`[Enter]`, `[Ctrl+F]`, `[C]`), an ALL-CAPS machine marker (`[GAP]`), a
   *  lowercase state chip (`[current]`) and a grouped badge (`[Open · Recent]`)
   *  are NOT active devices — and a badge inside a `primary` affordance is
   *  legitimately `primary` too. */
  readonly labelPrefixes: readonly string[]
}

/**
 * §11.3.2/§4.5: "at most one bracketed active label per painted frame". Scans
 * only the caller's CHROME rows for the caller's CHROME label prefixes, reads
 * every one's first cell, and asserts at most ONE PAINTED OCCURRENCE wears
 * `primary` — the same label painted twice is two active devices, so the count is
 * over occurrences, never over distinct names.
 *
 * Returns the distinct prefixes really found primary, so a caller can also assert
 * WHICH device is active this frame (and that the check was not vacuous).
 */
export function assertOneActiveDevice(frame: PaintedFrame, site: ActiveDeviceSite): string[] {
  const primaries: string[] = []
  const occurrences: string[] = []
  const found: string[] = []
  for (const rowIndex of site.rows) {
    const row = frame.rows[rowIndex]
    if (row === undefined) continue
    // Every occurrence of every prefix, not just the first.
    const matches: { readonly prefix: string; readonly col: number; readonly width: number }[] = []
    for (const prefix of site.labelPrefixes) {
      let at = row.indexOf(prefix)
      while (at >= 0) {
        matches.push({ prefix, col: visibleWidth(row.slice(0, at)), width: visibleWidth(prefix) })
        at = row.indexOf(prefix, at + 1)
      }
    }
    // A shorter prefix can match INSIDE a longer one (`[Out` in `[Output]`): keep
    // only the longest match covering each position, so one painted device is one
    // occurrence instead of two.
    const kept = matches
      .sort((left, right) => left.col - right.col || right.width - left.width)
      .filter((match, index, all) => !all.slice(0, index).some(prior =>
        prior.col <= match.col && match.col + match.width <= prior.col + prior.width))
    for (const match of kept) {
      // The prefix starts at the label's opening bracket; a counted label paints
      // the whole `[Label (n)]` device in one ink, so its first cell is the signal.
      const ink = frame.readColor(rowIndex, match.col)
      if (ink === undefined) continue
      found.push(`${match.prefix}@${rowIndex}:${match.col}`)
      if (ink !== frame.primaryRgb) continue
      occurrences.push(`${match.prefix}@${rowIndex}:${match.col}`)
      if (!primaries.includes(match.prefix)) primaries.push(match.prefix)
    }
  }
  assert.ok(occurrences.length <= 1,
    `at most ONE chrome active device may be painted primary, found ${occurrences.length} (${occurrences.join(', ')}); chrome labels seen: ${found.length === 0 ? 'none' : found.join(', ')}\n${frameText(frame.rows)}`)
  return primaries
}
