/** The shared PURE text and fact-row math of the native TSP pickers.
 *
 * It answers only "how many display columns does this text occupy" and "which
 * rows does one labelled fact become on the picker's measured one-line slot".
 * It renders nothing, reads no SDK state (only the picker item TYPE) and holds
 * no panel state, so the TSP presenters share ONE geometry instead of growing a
 * second, silently different one. It lives inside the TSP renderer module because
 * the SDK specifier is forbidden everywhere else.
 *
 * LIVE consumers today are {@link displayWidth} (the `/model` strip's own label
 * budget and its regression), {@link clampMiddle} (a strip chip that must keep its
 * distinguishing tail) and {@link oneLine} (a `/preset` card's ONE-line summary).
 * The fact-row group below — {@link factRowItems}, {@link factLineColumns},
 * {@link wrapColumns} and `PICKER_GLYPH_PX` — lost its only consumer when the
 * `/preset` details page was replaced by the Overview (a native `lg` overlay wraps
 * its values itself, so no measured one-line slot exists to pre-split into). It is
 * RETAINED deliberately: this module is the TSP pickers' shared measured-text
 * toolbox, its removal belongs with a decision about that toolbox as a whole, and
 * pruning it is not part of the native-preset revision.
 *
 * The measured slot constants below belong to the `sz-md` picker surface in its
 * compact drill-down shape (`/model`): the Owner-frozen environment numbers, not
 * SDK guarantees.
 * @module tui/tsp/picker-text
 */
import type { PickerItem } from '@stencil-hq/tern'

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/**
 * East Asian Wide/Fullwidth, emoji and supplementary planes occupy two columns;
 * everything else one. A conservative classification is fine here: it only makes
 * a wrap earlier and the layout budget smaller.
 */
const WIDE_GRAPHEME = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F000}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}]/u
const LINE_BREAK = /[\n\r\v\f\u2028\u2029]/

const columnsOf = (grapheme: string): number => {
  // A tab can advance to the next tab stop (several widest-glyph units), so it
  // is priced conservatively rather than as one column.
  if (grapheme === '\t') return 3
  return WIDE_GRAPHEME.test(grapheme) ? 2 : 1
}

/** The display columns of one text (never UTF-16 units). */
export function displayWidth(text: string): number {
  let width = 0
  for (const { segment } of graphemeSegmenter.segment(text)) width += columnsOf(segment)
  return width
}

/**
 * Wrap `text` into lines of at most `columns` DISPLAY columns, breaking on
 * grapheme boundaries (a surrogate pair is never split) and preferring the last
 * space (a break consumes it, which is what a word wrap does). An explicit
 * newline always breaks.
 */
export function wrapColumns(text: string, columns: number): readonly string[] {
  const lines: string[] = []
  let line = ''
  let width = 0
  /** Commit the current line KEEPING an empty one: the renderer preserves an
   *  explicit blank line, so dropping it would under-count the height. */
  const emit = (): void => {
    lines.push(line.trim())
    line = ''
    width = 0
  }
  const flushWrapped = (): void => {
    const trimmed = line.trim()
    if (trimmed === '') return
    lines.push(trimmed)
    line = ''
    width = 0
  }
  for (const { segment } of graphemeSegmenter.segment(text)) {
    // A grapheme cluster can CARRY the break (`\r\n` is one cluster, and a lone
    // CR or a Unicode line/paragraph separator is its own): every such segment
    // is exactly ONE rendered line break.
    if (LINE_BREAK.test(segment)) {
      emit()
      continue
    }
    const cell = columnsOf(segment)
    if (width + cell > columns && line !== '') {
      const space = line.lastIndexOf(' ')
      if (space > 0) {
        const rest = line.slice(space + 1)
        line = line.slice(0, space)
        flushWrapped()
        line = rest
        width = displayWidth(rest)
      } else {
        flushWrapped()
      }
    }
    line += segment
    width += cell
  }
  flushWrapped()
  return lines
}

/** Truncate one line to the worst-case column bound, marking the cut. A single
 *  clamped line is what an action-first column shows for a long value (the
 *  complete value stays readable in the Details page). */
export function clampColumns(text: string, columns: number): string {
  const graphemes = [...graphemeSegmenter.segment(text)].map((entry) => entry.segment)
  let width = 0
  let kept = ''
  for (const grapheme of graphemes) {
    const cell = columnsOf(grapheme)
    if (width + cell > columns) return `${kept.trimEnd()}…`
    kept += grapheme
    width += cell
  }
  return kept
}

/**
 * Clamp `text` to `columns` display columns with a MIDDLE ellipsis: a head and a
 * tail both survive.
 *
 * {@link clampColumns} keeps the head only, which is enough when the value's tail
 * carries nothing (`fact` rows). A strip chip is the ONE place an advertised effort
 * NAME is shown for a candidate that is not the draft, and names are free-form: two
 * of them can differ only in their tail (`Extended thinking (low)` vs
 * `Extended thinking (high)`), where a head-only clamp would render one label for
 * two different candidates. The ellipsis is the design language's content
 * truncation; the complete text stays with its owner.
 */
export function clampMiddle(text: string, columns: number): string {
  if (displayWidth(text) <= columns) return text
  const budget = Math.max(2, columns - 1)
  // The two ends share the budget evenly: a trailing discriminator is as long as a
  // typical leading word (`(high)`, `(low)`, `(max)`, `2.1`), and a 60/40 split
  // would clip the opening bracket off exactly the tail this clamp exists to keep.
  const head = Math.max(1, Math.ceil(budget / 2))
  const tail = Math.max(1, budget - head)
  const graphemes = [...graphemeSegmenter.segment(text)].map((entry) => entry.segment)
  const take = (source: readonly string[], room: number): string[] => {
    const kept: string[] = []
    let used = 0
    for (const grapheme of source) {
      const cell = columnsOf(grapheme)
      if (used + cell > room) break
      kept.push(grapheme)
      used += cell
    }
    return kept
  }
  const left = take(graphemes, head).join('')
  const right = take([...graphemes].reverse(), tail).reverse().join('')
  return `${left.trimEnd()}…${right.trimStart()}`
}

/**
 * The ONE-line form of a text: every whitespace run — an explicit LF, CRLF, CR
 * or Unicode line/paragraph separator included — collapses to a single space, so
 * the result is exactly one rendered line. The complete value always stays
 * readable on a Details page.
 */
export function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/* ------------------------------------------------------------- fact rows */

/** The measured ONE-line width a Details fact row offers its `detail`, in px.
 *
 *  The SDK renders a fact row's `detail` on a SINGLE measured 18px line and
 *  clips what does not fit with an ellipsis: an unbroken fragment never becomes
 *  two lines, so "the row is 36px tall" is not a readability budget. The two
 *  numbers below are the slots of the NARROWEST pane each layout supports, both
 *  measured in the real Tern production presenter:
 *
 *  - compact (`sz-md`, `narrow`, `pv-hide`): 286px at the 400px minimum
 *    supported pane width (560px gives 446px).
 *  - wide (`sz-lg`, side preview): 366px at 1040px — the narrowest pane the
 *    client keeps the details column BESIDE the list (at 1000-1020px it moves
 *    the preview below and the list becomes full width, which is wider and
 *    therefore covered by the same bound; 1100px gives 426px).
 */
const FACT_SLOT_COMPACT_PX = 286
const FACT_SLOT_WIDE_PX = 366
/** The Owner-frozen caps of one fact row (compact / wide). */
const FACT_LINE_COLUMNS_COMPACT = 11
const FACT_LINE_COLUMNS_WIDE = 21
/** The label of a fact row shares its line, and our labels are static ASCII of a
 *  known font: 9px per character is an upper bound of the measured ~6.4px/char
 *  (`Provider` measures 51px), so the room a label leaves is provable. */
const FACT_LABEL_CHAR_PX = 9
/** One column of slack: the slots above are integer measurements, and the
 *  rendered advance of the widest glyph is measured, not exactly 20px. */
const FACT_SLOT_SLACK_PX = 20

/**
 * The glyph advance bound of the picker's font.
 *
 * The pane renders PROPORTIONAL text, so a terminal-column count is not a line
 * count: a `'W'.repeat(34)` label wraps into two native rows even though 34
 * columns "fit". The measured widest ASCII glyph advance is ~14.6px, so every
 * character (and every 2-column CJK/emoji grapheme) is priced at 20px: the
 * resulting line count is an UPPER BOUND for any glyph mix, never an estimate.
 */
export const PICKER_GLYPH_PX = 20

/**
 * The display columns one Details fact row may carry on its single line, given
 * the label it shares that line with. Every character is priced at
 * {@link PICKER_GLYPH_PX} (the measured worst-case advance of one display column,
 * so any glyph mix is covered), the row's own label is subtracted, and the
 * Owner-frozen caps (11 compact / 21 wide) are upper bounds the measured slot
 * may tighten further.
 */
export function factLineColumns(wide: boolean, label: string): number {
  const slot = (wide ? FACT_SLOT_WIDE_PX : FACT_SLOT_COMPACT_PX)
    - label.length * FACT_LABEL_CHAR_PX
    - FACT_SLOT_SLACK_PX
  const cap = wide ? FACT_LINE_COLUMNS_WIDE : FACT_LINE_COLUMNS_COMPACT
  return Math.max(1, Math.min(cap, Math.floor(slot / PICKER_GLYPH_PX)))
}

/**
 * One labelled fact as complete, readable rows: the row that carries the label
 * shares its line with it, so its fragment fits the room the label leaves, and
 * the remainder continues on label-less rows at the full row bound. Every
 * fragment therefore fits its own row's measured ONE-line slot.
 *
 * Currently WITHOUT a production consumer: see this module's header for why it is
 * retained rather than pruned with the `/preset` details page it was built for.
 */
export function factRowItems(id: string, label: string, text: string, wide: boolean): PickerItem[] {
  const lines = wrapColumns(text, factLineColumns(wide, ''))
  const head = wrapColumns(lines[0] ?? '', factLineColumns(wide, label))
  const rows = [...head, ...lines.slice(1)]
  // A value that wraps to nothing (an empty advertised name) still keeps its
  // labelled row rather than disappearing from the page.
  if (rows.length === 0) rows.push('')
  return rows.map((line, index) => ({
    id: index === 0 ? id : `${id}-${index + 1}`,
    label: index === 0 ? label : '',
    detail: line,
  }))
}
