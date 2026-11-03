/**
 * Per-composer paste-range leases.
 *
 * A terminal bracketed paste inserts ordinary text; the asynchronous image
 * read that follows must later replace EXACTLY the bytes that paste inserted,
 * even after the user kept typing, moved the caret, or pasted twice. Neither
 * `indexOf(path)` nor the path string itself is an identity — a copied or
 * repeated path would land the replacement on the wrong occurrence.
 *
 * The identity is the span the editor actually inserted plus every REAL
 * mutation of that same editor. A longest-common-prefix/suffix inference is
 * NOT enough: two different edits can produce the same text (`/tmp/a.png `
 * with `png` inserted inside the path and `png` inserted after the trailing
 * separator are indistinguishable from the text alone). This module therefore
 * consumes EXACT splices: the TSP composer reports the position it mutated,
 * and the PiTui host proves the one splice at the editor's real pre-edit caret
 * ({@link proveCaretEdit}). Any change that cannot be proven exactly retires
 * every lease — the tracker never guesses a position.
 * @module @xmoon76/dsh-pi-tui/tui/interaction/pasted-path-range
 */

import { PASTE_CANDIDATE_MAX_LENGTH, candidateImagePathFromPaste } from '../../client/media/image/pasted-path.ts'

/** One tracked document interval: the expected bytes and where they live. */
export interface PasteRangeSpan {
  /** UTF-16 start offset in the editor's RAW text. */
  readonly start: number
  /** UTF-16 end offset (exclusive) in the editor's RAW text. */
  readonly end: number
  /** The exact bytes the interval must still hold to stay alive. */
  readonly expected: string
}

/** One EXACT raw-text splice: `old[start..oldEnd)` became `new[start..newEnd)`. */
export interface PasteTextEdit {
  readonly start: number
  readonly oldEnd: number
  readonly newEnd: number
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
 *
 * Only a body the candidate grammar accepts yields a span: a plain text paste
 * must not create a lease that would then track every later edit.
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
  if (candidateImagePathFromPaste(pastedText) === undefined) return undefined
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

/** Whether `edit` is a syntactically valid single splice of `beforeText`. */
function isSingleSplice(beforeText: string, edit: PasteTextEdit, afterText: string): boolean {
  if (!Number.isInteger(edit.start) || !Number.isInteger(edit.oldEnd) || !Number.isInteger(edit.newEnd)) return false
  if (edit.start < 0 || edit.oldEnd < edit.start || edit.newEnd < edit.start) return false
  if (edit.oldEnd > beforeText.length || edit.newEnd > afterText.length) return false
  if (edit.newEnd - edit.start !== afterText.length - beforeText.length + (edit.oldEnd - edit.start)) return false
  const spliced = beforeText.slice(0, edit.start) + afterText.slice(edit.start, edit.newEnd) + beforeText.slice(edit.oldEnd)
  return spliced === afterText
}

/**
 * Prove the ONE splice that turned `beforeText` into `afterText`, anchored at
 * the editor's REAL pre-edit caret. The four editor gestures that act at the
 * caret (insert, delete-before, delete-after, replace-at-caret) are tested;
 * an ambiguous proof, a multi-splice result or a missing anchor returns
 * `undefined`, so the caller retires the leases instead of guessing.
 *
 * This is not the ambiguous common-prefix/suffix inference: the candidate
 * start is the actual caret (or a caret-adjacent deletion), and a plain
 * insertion of the same bytes elsewhere can never masquerade as it.
 */
export function proveCaretEdit(
  beforeText: string,
  beforeCursor: number,
  afterText: string,
): PasteTextEdit | undefined {
  if (beforeCursor < 0 || beforeCursor > beforeText.length) return undefined
  if (beforeText === afterText) return undefined
  const delta = afterText.length - beforeText.length
  const candidates: PasteTextEdit[] = []
  const push = (edit: PasteTextEdit): void => {
    if (!isSingleSplice(beforeText, edit, afterText)) return
    const key = `${edit.start}:${edit.oldEnd}:${edit.newEnd}`
    if (!candidates.some(candidate => `${candidate.start}:${candidate.oldEnd}:${candidate.newEnd}` === key)) candidates.push(edit)
  }
  // Insertion at the caret.
  if (delta > 0) push({ start: beforeCursor, oldEnd: beforeCursor, newEnd: beforeCursor + delta })
  // Deletion ENDING at the caret (Backspace) and STARTING at the caret (Delete).
  if (delta < 0) {
    push({ start: beforeCursor + delta, oldEnd: beforeCursor, newEnd: beforeCursor + delta })
    push({ start: beforeCursor, oldEnd: beforeCursor - delta, newEnd: beforeCursor })
  }
  // Replacement at the caret (e.g. an accepted completion): keep the common
  // suffix after the caret and splice the differing middle.
  let suffix = 0
  const suffixLimit = Math.min(beforeText.length - beforeCursor, afterText.length - beforeCursor)
  while (suffix < suffixLimit && beforeText[beforeText.length - 1 - suffix] === afterText[afterText.length - 1 - suffix]) {
    suffix += 1
  }
  push({
    start: beforeCursor,
    oldEnd: beforeText.length - suffix,
    newEnd: afterText.length - suffix,
  })
  return candidates.length === 1 ? candidates[0] : undefined
}

/**
 * The short-lived ranges of ONE composer. The owner registers a paste span
 * right after the editor accepted it, feeds every REAL mutation as an exact
 * splice, and retires all ranges at any programmatic or unprovable change.
 */
export class PasteRangeTracker {
  private readonly ranges = new Map<number, { start: number; end: number; expected: string }>()
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

  /** Feed ONE EXACT editor splice and `nextText` the editor produced. A splice
   *  that does not reproduce `nextText` is not trusted: every lease is
   *  retired and the text adopted. */
  applyEdit(edit: PasteTextEdit, nextText: string): void {
    if (!isSingleSplice(this.currentText, edit, nextText)) {
      this.reset(nextText)
      return
    }
    const delta = edit.newEnd - edit.oldEnd
    for (const [id, range] of this.ranges) {
      const insertion = edit.oldEnd === edit.start
      let alive = true
      if (insertion) {
        if (edit.start <= range.start) {
          // Inserted at/left of the range: shift it. A character typed at the
          // LEFT boundary belongs BEFORE the anchor.
          range.start += delta
          range.end += delta
        } else if (edit.start < range.end) {
          // Inserted INSIDE the anchor: its bytes changed.
          alive = false
        }
        // else: inserted at/right of the range end — unchanged.
      } else if (edit.oldEnd <= range.start) {
        range.start += delta
        range.end += delta
      } else if (edit.start >= range.end) {
        // Change entirely after the range: unchanged.
      } else {
        alive = false
      }
      if (alive && nextText.slice(range.start, range.end) !== range.expected) alive = false
      if (!alive) this.ranges.delete(id)
    }
    this.currentText = nextText
  }

  /** Adopt `nextText` after a programmatic/unprovable change: every lease is
   *  retired (a lease never revives). */
  reset(nextText: string): void {
    this.ranges.clear()
    this.currentText = nextText
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
