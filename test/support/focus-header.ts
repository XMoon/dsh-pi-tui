/**
 * Focus disclosure-header row matching for the headless UI tests.
 *
 * The Focus header renders the whale disclosure glyph plus a status label
 * (`Working 3s`, `Waiting for approval · 1s`, `Turn complete 6s`, …). The SAME
 * whale glyphs are reused elsewhere in the viewport — the working indicator
 * shows `🐋 Working...` and the assistant bullet leads with `🐋 text` — so a
 * bare glyph needle is ambiguous. These helpers match the header's label
 * shape instead.
 * @module @xmoon76/dsh-pi-tui/test/support/focus-header
 */

/** The header status labels as truncation-safe STEMS: a narrow terminal
 * truncates the label (`🐳 Complete…`), but the stem survives. The header
 * uses a SINGLE space between the disclosure glyph and the label
 * (`${glyph} ${label}`), while the working indicator and the assistant
 * bullet use the two-space `iconPrefix` — so the single space plus the
 * line-start anchor excludes those look-alikes. */
const HEADER_LABEL = 'Work|Wait|Turn c|Compl|Fail|Interr|Block|Max'

/** The plain Work container header (`▸ Work`, `▸ Work · 3 tools · thinking`)
 * reuses the same section triangle as a Focus disclosure header, so the label
 * stem alone would misclassify it. Exclude the Work header SHAPE explicitly
 * instead of relying on a brittle lookahead on the label stem. */
const WORK_CONTAINER_HEADER = /^\s*[▸▾] Work(?:\s*(?:·.*|…+|\.\.\.))?\s*$/u

function headerPattern(expanded: boolean | undefined): RegExp {
  const collapsed = '(?:🐋|▸)'
  const expandedGlyph = '(?:🐳|▾)'
  const glyph = expanded === undefined ? `(?:${collapsed}|${expandedGlyph})` : expanded ? expandedGlyph : collapsed
  return new RegExp(`^\\s*${glyph} (?:${HEADER_LABEL})`, 'mu')
}

/** Whether one line is a Focus disclosure header (optionally requiring the
 * expanded or collapsed glyph). A Work container header is never a Focus
 * header. */
export function isFocusHeader(line: string, expanded?: boolean): boolean {
  if (WORK_CONTAINER_HEADER.test(line)) return false
  return headerPattern(expanded).test(line)
}

/** The first Focus header row in `lines`, or -1. */
export function findFocusHeaderRow(lines: readonly string[], expanded?: boolean): number {
  return lines.findIndex(line => isFocusHeader(line, expanded))
}

/** The last Focus header row in `lines`, or -1. */
export function findLastFocusHeaderRow(lines: readonly string[], expanded?: boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isFocusHeader(lines[index]!, expanded)) return index
  }
  return -1
}

/** Whether a (possibly joined) viewport text contains a Focus header. A Work
 * container header is never a Focus header (delegates to `isFocusHeader` so the
 * two helpers can never disagree). */
export function hasFocusHeader(text: string, expanded?: boolean): boolean {
  return text.split('\n').some(line => isFocusHeader(line, expanded))
}

/** The number of Focus headers in a (joined) viewport text. */
export function countFocusHeaders(text: string, expanded?: boolean): number {
  return text.split('\n').filter(line => isFocusHeader(line, expanded)).length
}
