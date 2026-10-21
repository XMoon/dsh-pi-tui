/**
 * The ONE cross-media Client draft lifecycle owner (TS8-C).
 *
 * One submission can reference staged images AND generic files; this module
 * owns the combined queries and mutations over the two Client-local draft
 * stores. It replaces the historical image-only helpers so tests and callers
 * exercise the SAME lifecycle the product path uses.
 *
 * Semantics preserved from the historical owners:
 * - `draftHasImages` / `draftHasAttachments` are strictly resolved against the
 *   live draft stores (a hand-edited or stale placeholder stays plain text);
 * - `pinDraftAttachments` reserves every referenced draft for one in-flight
 *   submission and returns an idempotent release;
 * - `consumeDraftAttachments` removes ONLY the drafts the submitted text
 *   references, so a concurrent intake racing a submission keeps its newly
 *   staged draft;
 * - `pruneUnreferencedDraftAttachments` never drops a draft an in-flight
 *   submission pinned.
 * @module @xmoon76/dsh-pi-tui/client/media/draft-attachments
 */

import { expandAttachmentPlaceholders } from './attachment/placeholder.ts'
import type { DraftFileStore, DraftFileStoreLike } from './attachment/file-draft.ts'
import { expandImagePlaceholders } from './image/placeholder.ts'
import type { DraftImageStore } from './image/draft-store.ts'
import type { DraftImageStoreLike } from './image/types.ts'

/** Whether the draft text references any staged image (the image-only
 * prompt gate shared by every submit path). */
export function draftHasImages(text: string, store: DraftImageStoreLike): boolean {
  return expandImagePlaceholders(text, store).some(segment => segment.type === 'image')
}

/** Whether text references a live image or generic-file draft. */
export function draftHasAttachments(
  text: string,
  imageStore: DraftImageStoreLike,
  fileStore?: DraftFileStoreLike,
): boolean {
  return expandAttachmentPlaceholders(text, imageStore, fileStore).some(segment => segment.type !== 'text')
}

/** Reserve every live image and file draft referenced by one submission. */
export function pinDraftAttachments(
  text: string,
  imageStore: DraftImageStore,
  fileStore?: DraftFileStore,
): () => void {
  const releaseImage = imageStore.pinReferenced(text)
  const releaseFile = fileStore?.pinReferenced(text)
  let released = false
  return () => {
    if (released) return
    released = true
    releaseImage()
    releaseFile?.()
  }
}

/**
 * Remove ONLY the drafts a submission actually consumed: the image/file ids
 * referenced by the submitted text. Never a wholesale clear — a concurrent
 * `/image` or Ctrl+V intake racing a submission keeps its newly staged draft.
 */
export function consumeDraftAttachments(
  text: string,
  imageStore: DraftImageStore,
  fileStore?: DraftFileStore,
): void {
  for (const segment of expandAttachmentPlaceholders(text, imageStore, fileStore)) {
    if (segment.type === 'image') imageStore.remove(segment.image.id)
    else if (segment.type === 'file') fileStore?.remove(segment.file.id)
  }
}

/**
 * Drop every draft the CURRENT editor text no longer references: deleting a
 * placeholder (or Ctrl+C clearing the editor) would otherwise leave the staged
 * bytes in the store until capacity runs out. Called BEFORE a new attach (the
 * editor text at that moment is the truth of what is still wanted).
 * Drafts pinned by an in-flight submission are kept — the editor is cleared
 * before dispatch, so an attach must never delete the drafts a pending
 * submission is about to admit.
 */
export function pruneUnreferencedDraftAttachments(
  text: string,
  imageStore: DraftImageStore,
  fileStore?: DraftFileStore,
): void {
  const referencedImages = new Set<number>()
  const referencedFiles = new Set<number>()
  for (const segment of expandAttachmentPlaceholders(text, imageStore, fileStore)) {
    if (segment.type === 'image') referencedImages.add(segment.image.id)
    else if (segment.type === 'file') referencedFiles.add(segment.file.id)
  }
  for (const image of imageStore.values()) {
    if (!referencedImages.has(image.id) && !imageStore.isPinned(image.id)) imageStore.remove(image.id)
  }
  if (fileStore !== undefined) {
    for (const file of fileStore.values()) {
      if (!referencedFiles.has(file.id) && !fileStore.isPinned(file.id)) fileStore.remove(file.id)
    }
  }
}
