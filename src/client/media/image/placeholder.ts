/**
 * Placeholder formatting and expansion for the editor draft (plan M1, §6).
 *
 * The placeholder is plain text inside the editor: `[image #1 (1920×1080)]`.
 * Expansion is a STRICT lookup: a placeholder only resolves to an image when
 * its text matches a live draft's canonical placeholder exactly — a user
 * hand-edited dimension or a stale id stays ordinary text (§6.2), so the
 * editor remains free-form text and nothing but a real staged draft can
 * become an image on submit.
 * @module @xmoon76/dsh-pi-tui/client/media/image/placeholder
 */

import type { DraftImage, DraftImageStoreLike } from './types.ts'

/** The canonical editor placeholder for one draft image. */
export function formatImagePlaceholder(id: number, width: number, height: number): string {
  return `[image #${id} (${width}×${height})]`
}

/** One parsed slice of a draft: either plain text or a staged image. */
export type DraftSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly image: DraftImage }

/**
 * One canonical placeholder occurrence in the draft text. `ordinal` is the
 * 0-based rank among ALL canonical occurrences (a repeated token is a
 * distinct occurrence), matching the editor's visual order. The offsets are
 * UTF-16 string offsets into the exact text passed in.
 */
export interface DraftImageOccurrence {
  readonly image: DraftImage
  readonly startOffset: number
  readonly endOffset: number
  readonly ordinal: number
}

/**
 * Scan the draft text for live canonical placeholder occurrences. This is
 * the ONE parser behind both submission expansion and the read-only
 * preview/removal projection: it uses the exact same strict lookup (the
 * current staged placeholder), earliest-occurrence ordering and insertion
 * order tie-break, so the preview can never disagree with what would be
 * submitted.
 * @param text - the editor draft.
 * @param store - the live draft store (structural; only `values()` is read).
 * @returns every occurrence in text order; a repeated token yields one entry
 *   per appearance.
 */
export function selectDraftImageOccurrences(
  text: string,
  store: DraftImageStoreLike,
): readonly DraftImageOccurrence[] {
  const candidates = store.values()
  if (candidates.length === 0 || text === '') return []
  const occurrences: DraftImageOccurrence[] = []
  let cursor = 0
  while (cursor < text.length) {
    // Earliest placeholder occurrence from the current cursor wins; ties are
    // broken by insertion order (values() is the store's iteration order).
    let bestIndex = -1
    let best: DraftImage | undefined
    for (const image of candidates) {
      const index = text.indexOf(image.placeholder, cursor)
      if (index !== -1 && (best === undefined || index < bestIndex)) {
        bestIndex = index
        best = image
      }
    }
    if (best === undefined) break
    occurrences.push({
      image: best,
      startOffset: bestIndex,
      endOffset: bestIndex + best.placeholder.length,
      ordinal: occurrences.length,
    })
    cursor = bestIndex + best.placeholder.length
  }
  return occurrences
}

/**
 * Expand the draft text into ordered segments: every canonical placeholder
 * whose draft is still staged becomes an image segment, everything else
 * stays text. Adjacent text segments are merged and empty text segments are
 * dropped, so a submission can map the segments one-to-one onto
 * `ContentBlock`s without re-normalizing whitespace (§6.2 items 4-5).
 * @param text - the editor draft.
 * @param store - the live draft store (structural; only `values()` is read).
 * @returns the segments in original order.
 */
export function expandImagePlaceholders(
  text: string,
  store: DraftImageStoreLike,
): readonly DraftSegment[] {
  const occurrences = selectDraftImageOccurrences(text, store)
  if (occurrences.length === 0) {
    return text === '' ? [] : [{ type: 'text', text }]
  }
  const segments: DraftSegment[] = []
  let cursor = 0
  for (const occurrence of occurrences) {
    if (occurrence.startOffset > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, occurrence.startOffset) })
    }
    segments.push({ type: 'image', image: occurrence.image })
    cursor = occurrence.endOffset
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor) })
  }
  // Merge adjacent text segments (a trailing text segment after an image can
  // never be merged with a leading one, but repeated scans keep segments
  // alternating text/image; empty text segments are dropped).
  const merged: DraftSegment[] = []
  for (const segment of segments) {
    const previous = merged[merged.length - 1]
    if (segment.type === 'text' && segment.text === '') continue
    if (segment.type === 'text' && previous !== undefined && previous.type === 'text') {
      merged[merged.length - 1] = { type: 'text', text: previous.text + segment.text }
    } else {
      merged.push(segment)
    }
  }
  return merged
}
