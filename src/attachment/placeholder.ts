/**
 * Strict expansion for mixed image and generic-file draft placeholders.
 *
 * Only exact, currently staged placeholders become attachment segments. Every
 * other character remains text, including edited or stale placeholder tokens.
 * @module @xmoon76/dsh-pi-tui/attachment/placeholder
 */

import type { DraftFile, DraftFileStoreLike } from './file-draft.ts'
import type { DraftImage, DraftImageStoreLike } from '../image/types.ts'

/** One ordered slice of a mixed draft. */
export type DraftAttachmentSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly image: DraftImage }
  | { readonly type: 'file'; readonly file: DraftFile }

type Candidate =
  | { readonly type: 'image'; readonly value: DraftImage; readonly placeholder: string }
  | { readonly type: 'file'; readonly value: DraftFile; readonly placeholder: string }

/**
 * Expand exact image/file placeholders while preserving all surrounding text
 * and its whitespace.
 */
export function expandAttachmentPlaceholders(
  text: string,
  imageStore: DraftImageStoreLike,
  fileStore: DraftFileStoreLike | undefined = undefined,
): readonly DraftAttachmentSegment[] {
  const candidates: readonly Candidate[] = [
    ...imageStore.values().map(image => ({ type: 'image' as const, value: image, placeholder: image.placeholder })),
    ...(fileStore?.values().map(file => ({ type: 'file' as const, value: file, placeholder: file.placeholder })) ?? []),
  ]
  if (candidates.length === 0) return text === '' ? [] : [{ type: 'text', text }]

  const segments: DraftAttachmentSegment[] = []
  let cursor = 0
  while (cursor < text.length) {
    let bestIndex = -1
    let best: Candidate | undefined
    for (const candidate of candidates) {
      const index = text.indexOf(candidate.placeholder, cursor)
      if (index !== -1 && (best === undefined || index < bestIndex)) {
        bestIndex = index
        best = candidate
      }
    }
    if (best === undefined) break
    if (bestIndex > cursor) segments.push({ type: 'text', text: text.slice(cursor, bestIndex) })
    segments.push(best.type === 'image'
      ? { type: 'image', image: best.value }
      : { type: 'file', file: best.value })
    cursor = bestIndex + best.placeholder.length
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) })

  const merged: DraftAttachmentSegment[] = []
  for (const segment of segments) {
    if (segment.type === 'text' && segment.text === '') continue
    const previous = merged[merged.length - 1]
    if (segment.type === 'text' && previous?.type === 'text') {
      merged[merged.length - 1] = { type: 'text', text: previous.text + segment.text }
    } else {
      merged.push(segment)
    }
  }
  return merged
}

/** Whether text contains a currently live image or file placeholder. */
export function draftHasAttachments(
  text: string,
  imageStore: DraftImageStoreLike,
  fileStore?: DraftFileStoreLike,
): boolean {
  return expandAttachmentPlaceholders(text, imageStore, fileStore).some(segment => segment.type !== 'text')
}

/** Whether text contains a currently live GENERIC-FILE placeholder (a
 * command invocation cannot carry one: the host expects an upload receipt
 * this client has no seam to produce). */
export function draftHasFiles(
  text: string,
  imageStore: DraftImageStoreLike,
  fileStore?: DraftFileStoreLike,
): boolean {
  return expandAttachmentPlaceholders(text, imageStore, fileStore).some(segment => segment.type === 'file')
}
