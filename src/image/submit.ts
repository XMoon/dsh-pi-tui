/**
 * Draft → UserMessage preparation for every agent-bound path (plan M6,
 * §13): followup, steer and queue all receive the SAME prepared message, so
 * no path can silently drop an `ImageBlock` (queue messages are durable
 * `UserMessage`s in the agent inbox — the queue never re-derives images
 * from drafts, §13.3).
 *
 * The pipeline: canonicalize mentions → expand mixed placeholders → (image
 * present) model capability gate → batched image admission and streamed file
 * admission → ordered ContentBlocks → `createUserMessage`. A text-only draft
 * keeps the exact legacy path (single text block, no service calls).
 * @module @xmoon76/dsh-pi-tui/image/submit
 */

import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { admitDraftImages, type AttachmentsLike, type ImageAttachmentRefLike } from './admission.ts'
import { assertModelSupportsImages, type LlmLike } from './capability.ts'
import { ImageAdmissionError } from './errors.ts'
import { expandImagePlaceholders, type DraftSegment } from './placeholder.ts'
import type { DraftImageStoreLike } from './types.ts'
import type { DraftImageStore } from './draft-store.ts'
import { expandAttachmentPlaceholders, type DraftAttachmentSegment } from '../attachment/placeholder.ts'
import { admitDraftFiles, type FileAttachmentRefLike, type FileAttachmentStoreLike } from '../attachment/file-admission.ts'
import type { DraftFileStore, DraftFileStoreLike } from '../attachment/file-draft.ts'
import { FileInputError } from '../attachment/intake.ts'

/** The live provider/model pair (the runner's current selection). */
export interface CurrentModelLike {
  readonly provider: string
  readonly model: string
}

/** Injectable service surface for draft preparation. */
export interface PrepareInputDeps {
  /** The live `ctx.attachments` service; undefined = attachment intake disabled. */
  readonly attachments: AttachmentsLike | undefined
  /** The live generic-file draft store, when the runner has one. */
  readonly fileStore?: DraftFileStoreLike
  /** The optional submit cancellation signal. */
  readonly signal?: AbortSignal
  /** The live `ctx.llm` service; undefined = capability gate skipped. */
  readonly llm: LlmLike | undefined
  /** The CURRENT provider/model (re-read at submit time — the TUI supports
   * runtime model switching, plan §12). */
  currentModel(): CurrentModelLike | undefined
  /** The session's working directory — the resolution base for send-time
   * `@`-file mention canonicalization (the 2026-08-22 plan, item 7). */
  sessionCwd(): string
  /** Send-time `@`-file mention canonicalization through the Host-file
   * port (migration M1.10) — the runner wires the live session scope. */
  canonicalizeMentions(text: string): Promise<string>
}

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

/** Consume only the image/file drafts referenced by a successful submission. */
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

/** Prune unreferenced, unpinned image and file drafts. */
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

/**
 * Remove ONLY the drafts a submission actually consumed (plan §14): the
 * image ids referenced by the submitted text. Never a wholesale clear — a
 * concurrent /image or Ctrl+V intake racing a submission keeps its newly
 * staged draft (round-5 finding 1).
 */
export function consumeDraftImages(text: string, store: DraftImageStore): void {
  for (const segment of expandImagePlaceholders(text, store)) {
    if (segment.type === 'image') store.remove(segment.image.id)
  }
}

/**
 * Drop every draft the CURRENT editor text no longer references (review
 * finding 2): deleting a placeholder (or Ctrl+C clearing the editor) leaves
 * the staged bytes in the store until capacity runs out — 16 stale
 * attachments then block the next /image with "Too many staged images".
 * Called BEFORE a new attach (the editor text at that moment is the truth
 * of what is still wanted). Drafts pinned by an in-flight submission are
 * kept — the editor is cleared before dispatch, so an attach must never
 * delete the images a pending prepareUserMessage is about to admit
 * (review finding 1).
 */
export function pruneUnreferencedDrafts(text: string, store: DraftImageStore): void {
  const referenced = new Set<number>()
  for (const segment of expandImagePlaceholders(text, store)) {
    if (segment.type === 'image') referenced.add(segment.image.id)
  }
  for (const image of store.values()) {
    if (!referenced.has(image.id) && !store.isPinned(image.id)) store.remove(image.id)
  }
}

/**
 * Prepare the immutable `UserMessage` for one submission.
 * @param text - the editor draft text.
 * @param store - the live draft store.
 * @param deps - the service surface.
 * @returns the frozen user message.
 * @throws ImageAdmissionError/FileInputError when the deployment has no
 *   attachment service but the live draft references an attachment;
 *   capability/admission errors otherwise.
 */
export async function prepareUserMessage(
  text: string,
  store: DraftImageStoreLike,
  deps: PrepareInputDeps,
): Promise<UserMessage> {
  // Host `@`-mention canonicalization must run before strict local
  // attachment-placeholder expansion. Canonical placeholders contain no `@`.
  deps.signal?.throwIfAborted()
  const canonical = await deps.canonicalizeMentions(text)
  deps.signal?.throwIfAborted()
  const segments = expandAttachmentPlaceholders(canonical, store, deps.fileStore)
  const imageSegments = segments
    .filter((segment): segment is Extract<DraftAttachmentSegment, { type: 'image' }> => segment.type === 'image')
    .map(segment => ({ type: 'image' as const, image: segment.image }))
  const fileSegments = segments
    .filter((segment): segment is Extract<DraftAttachmentSegment, { type: 'file' }> => segment.type === 'file')
    .map(segment => segment.file)
  const hasImage = imageSegments.length > 0
  const hasFile = fileSegments.length > 0
  if (!hasImage && !hasFile) {
    return createUserMessage({
      content: [{ type: 'text', text: canonical }],
      source: { kind: 'user' },
    })
  }
  if (deps.attachments === undefined) {
    throw hasImage
      ? new ImageAdmissionError('Image attachments are unavailable in this deployment.')
      : new FileInputError('File attachment storage is unavailable.')
  }
  // Only image-bearing messages use the model capability gate. Generic files
  // are valid for text-only models and must not probe image capabilities.
  if (hasImage) {
    const current = deps.currentModel()
    if (deps.llm !== undefined && current !== undefined) {
      await assertModelSupportsImages(deps.llm, current.provider, current.model)
      deps.signal?.throwIfAborted()
    }
  }
  deps.signal?.throwIfAborted()
  const imageRefs: readonly ImageAttachmentRefLike[] = hasImage
    ? (await admitDraftImages(imageSegments, deps.attachments)).refs
    : []
  deps.signal?.throwIfAborted()
  const fileRefs: readonly FileAttachmentRefLike[] = hasFile
    ? await admitDraftFiles(fileSegments, deps.attachments as unknown as FileAttachmentStoreLike, deps.signal)
    : []
  deps.signal?.throwIfAborted()
  return createUserMessage({
    content: [...buildAttachmentContentBlocks(segments, imageRefs, fileRefs)],
    source: { kind: 'user' },
  })
}

function buildAttachmentContentBlocks(
  segments: readonly DraftAttachmentSegment[],
  imageRefs: readonly ImageAttachmentRefLike[],
  fileRefs: readonly FileAttachmentRefLike[],
): readonly ContentBlock[] {
  const blocks: ContentBlock[] = []
  let imageIndex = 0
  let fileIndex = 0
  for (const segment of segments) {
    if (segment.type === 'text') {
      if (segment.text !== '') blocks.push({ type: 'text', text: segment.text })
      continue
    }
    if (segment.type === 'image') {
      const ref = imageRefs[imageIndex++]
      if (ref === undefined) throw new ImageAdmissionError('An image draft could not be admitted (reference mismatch).')
      blocks.push({ type: 'image', attachment: ref as never })
      continue
    }
    const ref = fileRefs[fileIndex++]
    if (ref === undefined) throw new FileInputError('A file draft could not be admitted (reference mismatch).')
    blocks.push({ type: 'file', attachment: ref as never })
  }
  if (imageIndex !== imageRefs.length || fileIndex !== fileRefs.length) {
    throw new ImageAdmissionError('The attachment service returned mismatched references.')
  }
  return blocks
}
