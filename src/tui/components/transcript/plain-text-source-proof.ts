/**
 * Disposable source-to-cell witness for ONE current plain-text transcript
 * search hit: the semantic source range is projected through the SAME
 * sanitizer and rebuilt through the SAME Host text/bubble constructor as the
 * live card, with a zero-width OSC 8 marker around the match. The temporary
 * probe rows are compared with the card's REAL render rows; only a strict
 * visible-text/width match may publish painted-cell segments.
 *
 * This is not a second search index and it is not a text position map for the
 * whole history: the marker string never reaches a mounted component, the
 * terminal, a log or a persistent field, and the module only runs once for the
 * current target.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/plain-text-source-proof
 */

import {
  getGraphemeSegmenter,
  getOsc8LinkAtColumn,
  stripTerminalSequences,
  visibleWidth,
  type AltScreenSearchSegment,
} from '@xmoon76/pi-tui'
import { rawSourceRangeForNormalizedMatch } from '../../../domain/transcript/search.ts'
import { sanitizeDisplayText } from '../../presentation/terminal-text.ts'

/** The witness URL is never printed to the user: `.invalid` is reserved
 * (RFC 2606), so it cannot resolve to a real service if it ever leaked. */
const PROBE_URL = 'https://dsh-pi-tui-search-proof.invalid/current'
const OPEN = `\x1b]8;;${PROBE_URL}\x1b\\`
const CLOSE = '\x1b]8;;\x1b\\'

const graphemeSegmenter = getGraphemeSegmenter()

/** One prepared witness: the display string with a zero-width marker around
 * the projected match, plus the non-whitespace visible graphemes that marker
 * must recover. */
export interface PlainTextSourceProbe {
  readonly taggedDisplayText: string
  readonly expectedVisibleMatch: string
}

function graphemeBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>([0, text.length])
  for (const segment of graphemeSegmenter.segment(text)) boundaries.add(segment.index)
  return boundaries
}

/**
 * Prepare the disposable witness for one source-local normalized range, or
 * `undefined` when the range cannot be proven to correspond to real, visible
 * source codepoints.
 */
export function preparePlainTextSourceProbe(
  rawSourceText: string,
  normalizedRange: { readonly start: number; readonly end: number },
  normalizedNeedle: string,
): PlainTextSourceProbe | undefined {
  if (normalizedNeedle === '') return undefined
  const rawRange = rawSourceRangeForNormalizedMatch(rawSourceText, normalizedRange)
  if (rawRange === undefined) return undefined
  // The range must still describe the CURRENT query over the CURRENT source:
  // an offset from an older query is not evidence for this one.
  if (rawSourceText.toLowerCase().slice(normalizedRange.start, normalizedRange.end) !== normalizedNeedle) return undefined

  const before = rawSourceText.slice(0, rawRange.start)
  const matched = rawSourceText.slice(rawRange.start, rawRange.end)
  const after = rawSourceText.slice(rawRange.end)
  const safeBefore = sanitizeDisplayText(before)
  const safeMatch = sanitizeDisplayText(matched)
  const safeAfter = sanitizeDisplayText(after)
  const projected = sanitizeDisplayText(rawSourceText)
  // A source range that crosses a control sequence (half an escape, a CR
  // pair, an ANSI span) cannot be projected locally without changing the
  // painted text; only the whole-source projection is authoritative.
  if (safeBefore + safeMatch + safeAfter !== projected) return undefined

  const rawBoundaries = graphemeBoundaries(rawSourceText)
  if (!rawBoundaries.has(rawRange.start) || !rawBoundaries.has(rawRange.end)) return undefined
  const projectedBoundaries = graphemeBoundaries(projected)
  const matchStart = safeBefore.length
  const matchEnd = safeBefore.length + safeMatch.length
  if (!projectedBoundaries.has(matchStart) || !projectedBoundaries.has(matchEnd)) return undefined

  const visibleGraphemes: string[] = []
  for (const segment of graphemeSegmenter.segment(safeMatch)) {
    if (visibleWidth(segment.segment) <= 0) continue
    if (/\s/u.test(segment.segment)) continue
    visibleGraphemes.push(segment.segment)
  }
  const expectedVisibleMatch = visibleGraphemes.join('')
  if (expectedVisibleMatch === '') return undefined

  return {
    taggedDisplayText: safeBefore + OPEN + safeMatch + CLOSE + safeAfter,
    expectedVisibleMatch,
  }
}

/**
 * Recover the painted cells of the marked match from the probe rows, but only
 * when the probe rendered the exact same visible rows as the live card.
 * Returned segments are non-whitespace only, ordered by row/column and merged
 * per word run, so bubble padding and Thinking indentation never get painted.
 */
export function provePlainTextPaintedSegments(
  originalLines: readonly string[],
  probeLines: readonly string[],
  expectedVisibleMatch: string,
): readonly AltScreenSearchSegment[] | undefined {
  if (expectedVisibleMatch === '' || originalLines.length === 0 || originalLines.length !== probeLines.length) return undefined
  for (let row = 0; row < originalLines.length; row += 1) {
    const original = originalLines[row]!
    const probe = probeLines[row]!
    if (stripTerminalSequences(probe) !== stripTerminalSequences(original)) return undefined
    if (visibleWidth(probe) !== visibleWidth(original)) return undefined
  }

  const segments: AltScreenSearchSegment[] = []
  const collected: string[] = []
  for (let row = 0; row < probeLines.length; row += 1) {
    const line = probeLines[row]!
    let column = 0
    for (const { segment } of graphemeSegmenter.segment(stripTerminalSequences(line))) {
      const width = visibleWidth(segment)
      const startCol = column
      column += width
      if (width <= 0) continue
      if (getOsc8LinkAtColumn(line, startCol) !== PROBE_URL) continue
      // A wide grapheme must be marked on BOTH edge cells: a truncated marker
      // would otherwise paint half a glyph.
      if (width > 1 && getOsc8LinkAtColumn(line, column - 1) !== PROBE_URL) return undefined
      if (/\s/u.test(segment)) continue
      collected.push(segment)
      const previous = segments.at(-1)
      if (previous !== undefined && previous.row === row && previous.endCol === startCol) {
        segments[segments.length - 1] = { row, startCol: previous.startCol, endCol: column }
      } else {
        segments.push({ row, startCol, endCol: column })
      }
    }
  }

  // The marker must recover EXACTLY the projected source match: a lost,
  // truncated or polluted marker is not a proof.
  if (collected.join('') !== expectedVisibleMatch) return undefined
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!
    const line = originalLines[segment.row]
    if (line === undefined || segment.startCol >= segment.endCol || segment.endCol > visibleWidth(line)) return undefined
    const previous = segments[index - 1]
    if (previous !== undefined && (previous.row > segment.row
      || (previous.row === segment.row && previous.endCol > segment.startCol))) return undefined
  }
  return segments.length > 0 ? segments : undefined
}
