/**
 * Per-composer paste-range leases.
 *
 * A terminal bracketed paste inserts ordinary text; the asynchronous image
 * read that follows must later replace EXACTLY the bytes that paste inserted,
 * even after the user kept typing, moved the caret, or pasted twice. Neither
 * `indexOf(path)` nor the path string itself is an identity — a copied or
 * repeated path would land the replacement on the wrong occurrence.
 *
 * This module owns the only identity that is real: the span the editor
 * actually inserted (measured from the before/after document + caret around
 * the one atomic paste) and the subsequent real edits of that same editor. A
 * range stays alive only while the editor still holds the same bytes at the
 * same identity; any edit that can cover it retires it. The tracker is a
 * SHORT-LIVED local mutation fact — it is not a second draft, and the editor
 * text/Undo history remain the authority.
 * @module @xmoon76/dsh-pi-tui/tui/interaction/pasted-path-range
 */

import { PASTE_CANDIDATE_MAX_LENGTH } from '../../client/media/image/pasted-path.ts'

/** One tracked document interval: the expected bytes and where they live. */
export interface PasteRangeSpan {
  /** UTF-16 start offset in the editor's RAW text. */
  readonly start: number
  /** UTF-16 end offset (exclusive) in the editor's RAW text. */
  readonly end: number
  /** The exact bytes the interval must still hold to stay alive. */
  readonly expected: string
}

/**
 * Measure the span ONE atomic paste inserted.
 *
 * The vendored editor may prepend a readability space to a path-like paste
 * that lands after a word character; that space belongs to the insertion but
 * never to the path identity. The terminal's own single trailing separator
 * space is equally outside the path token. When the insertion cannot be
 * proven to be exactly `pastedText` (optionally with that one leading space) —
 * a large-paste marker, control-character filtering, a line-ending rewrite —
 * no span is returned, so a candidate paste never guesses offsets.
 * @param beforeText - the raw document before the paste.
 * @param beforeCursor - the flat caret offset before the paste.
 * @param afterText - the raw document after the paste.
 * @param afterCursor - the flat caret offset after the paste.
 * @param pastedText - the complete bracketed-paste body.
 */
export function pastedBodySpan(
  beforeText: string,
  beforeCursor: number,
  afterText: string,
  afterCursor: number,
  pastedText: string,
): PasteRangeSpan | undefined {
  if (pastedText === '') return undefined
  // A body the candidate grammar can never accept is not tracked at all:
  // retaining it would force a full-body slice comparison on every later editor
  // edit for a conversion that can never happen.
  if (pastedText.length > PASTE_CANDIDATE_MAX_LENGTH) return undefined
  if (beforeCursor < 0 || beforeCursor > beforeText.length) return undefined
  if (afterCursor < beforeCursor || afterCursor > afterText.length) return undefined
  // The insertion must be ONE splice at the caret: the prefix and suffix of
  // the document outside it are unchanged.
  if (afterText.slice(0, beforeCursor) !== beforeText.slice(0, beforeCursor)) return undefined
  if (afterText.slice(afterCursor) !== beforeText.slice(beforeCursor)) return undefined
  const inserted = afterText.slice(beforeCursor, afterCursor)
  let start = beforeCursor
  let body: string
  if (inserted === pastedText) {
    body = inserted
  } else if (inserted === ` ${pastedText}`) {
    // The fork's path-readability space (see Editor.handlePaste).
    start += 1
    body = pastedText
  } else {
    return undefined
  }
  const path = body.endsWith(' ') ? body.slice(0, -1) : body
  if (path === '') return undefined
  return { start, end: start + path.length, expected: path }
}

/**
 * The short-lived ranges of ONE composer. Callers register the span of a
 * paste right after the editor accepted it, feed every subsequent REAL
 * document change through {@link observe}, and retire all ranges at any
 * programmatic replacement (session restore, seat handoff, forced clear) —
 * a restored draft that happens to contain the same path is NOT the original
 * paste and must never be claimed.
 */
/** The tracker's mutable live copy of one span. */
interface TrackedSpan {
  start: number
  end: number
  readonly expected: string
}

export class PasteRangeTracker {
  private readonly ranges = new Map<number, TrackedSpan>()
  private nextId = 1
  private currentText = ''

  /** Register one paste span against the CURRENT observed text. Fails closed
   *  when the document does not hold exactly those bytes. */
  add(span: PasteRangeSpan): number | undefined {
    if (span.start < 0 || span.end <= span.start || span.end > this.currentText.length) return undefined
    if (this.currentText.slice(span.start, span.end) !== span.expected) return undefined
    const id = this.nextId++
    this.ranges.set(id, { start: span.start, end: span.end, expected: span.expected })
    return id
  }

  /** Feed ONE real document change (the raw text after it). */
  observe(nextText: string): void {
    const previous = this.currentText
    if (nextText === previous) return
    this.currentText = nextText
    if (this.ranges.size === 0) return
    // The single splice a real editor mutation produces: the longest common
    // prefix, then a NON-OVERLAPPING longest common suffix.
    let prefix = 0
    const prefixLimit = Math.min(previous.length, nextText.length)
    while (prefix < prefixLimit && previous[prefix] === nextText[prefix]) prefix += 1
    let suffix = 0
    const suffixLimit = Math.min(previous.length - prefix, nextText.length - prefix)
    while (
      suffix < suffixLimit
      && previous[previous.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
    ) {
      suffix += 1
    }
    const oldEnd = previous.length - suffix
    const delta = (nextText.length - suffix) - oldEnd
    for (const [id, range] of this.ranges) {
      let alive = true
      if (oldEnd === prefix) {
        // Pure insertion at `prefix`.
        if (prefix <= range.start) {
          // Inserted at/left of the range: shift it. A character typed at the
          // LEFT boundary belongs BEFORE the anchor.
          range.start += delta
          range.end += delta
        } else if (prefix < range.end) {
          // Inserted inside the anchor: its bytes changed.
          alive = false
        }
        // else: inserted at/right of the range end — the range is unchanged.
      } else if (oldEnd <= range.start) {
        range.start += delta
        range.end += delta
      } else if (prefix >= range.end) {
        // Change entirely after the range: unchanged.
      } else {
        alive = false
      }
      if (alive && nextText.slice(range.start, range.end) !== range.expected) alive = false
      // A dead lease is permanent and is dropped now: it can never revive and
      // must not accumulate across a long session's pastes.
      if (!alive) this.ranges.delete(id)
    }
  }

  /** The live span for `id`, or `undefined` when retired/replaced. */
  live(id: number): PasteRangeSpan | undefined {
    const range = this.ranges.get(id)
    if (range === undefined) return undefined
    if (this.currentText.slice(range.start, range.end) !== range.expected) {
      this.ranges.delete(id)
      return undefined
    }
    return { start: range.start, end: range.end, expected: range.expected }
  }

  /** Retire one range (it will never become alive again). */
  retire(id: number): void {
    this.ranges.delete(id)
  }

  /** Retire every range: a programmatic replacement is not an edit history. */
  retireAll(): void {
    this.ranges.clear()
  }
}
