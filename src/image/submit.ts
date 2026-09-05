/**
 * Draft → UserMessage preparation for every agent-bound path (plan M6,
 * §13): followup, steer and queue all receive the SAME prepared message, so
 * no path can silently drop an `ImageBlock` (queue messages are durable
 * `UserMessage`s in the agent inbox — the queue never re-derives images
 * from drafts, §13.3).
 *
 * The pipeline: expand placeholders → (image present) model capability gate
 * → batched `saveImages()` → ordered ContentBlocks → `createUserMessage`.
 * A text-only draft keeps the exact legacy path (single text block, no
 * service calls), so the no-image fast path is unchanged.
 * @module @xmoon76/dsh-pi-tui/image/submit
 */

import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { admitDraftImages, type AttachmentsLike } from './admission.ts'
import { assertModelSupportsImages, type LlmLike } from './capability.ts'
import { ImageAdmissionError } from './errors.ts'
import { expandImagePlaceholders, type DraftSegment } from './placeholder.ts'
import type { DraftImageStoreLike } from './types.ts'
import type { DraftImageStore } from './draft-store.ts'

/** The live provider/model pair (the runner's current selection). */
export interface CurrentModelLike {
  readonly provider: string
  readonly model: string
}

/** Injectable service surface for draft preparation. */
export interface PrepareInputDeps {
  /** The live `ctx.attachments` service; undefined = image intake disabled. */
  readonly attachments: AttachmentsLike | undefined
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
 * @throws ImageAdmissionError when the deployment has no attachment service
 *   but the draft references images; capability/admission errors otherwise.
 */
export async function prepareUserMessage(
  text: string,
  store: DraftImageStoreLike,
  deps: PrepareInputDeps,
): Promise<UserMessage> {
  // Send-time `@`-file mention canonicalization (the 2026-08-22 plan,
  // item 7): the editor keeps the concise relative form, the model
  // receives the absolute path. Runs BEFORE image-placeholder expansion —
  // a canonical placeholder contains no `@`, so strict placeholder
  // matching is unaffected. The canonicalization itself is Host-owned
  // (migration M1.10) — the deps carry the port-backed seam.
  const canonical = await deps.canonicalizeMentions(text)
  const segments = expandImagePlaceholders(canonical, store)
  const hasImage = segments.some(segment => segment.type === 'image')
  if (!hasImage) {
    return createUserMessage({
      content: [{ type: 'text', text: canonical }],
      source: { kind: 'user' },
    })
  }
  if (deps.attachments === undefined) {
    throw new ImageAdmissionError('Image attachments are unavailable in this deployment.')
  }
  // Capability gate BEFORE admission: a declared text-only model rejects
  // the submission without spending a durable attachment (plan §12).
  const current = deps.currentModel()
  if (deps.llm !== undefined && current !== undefined) {
    await assertModelSupportsImages(deps.llm, current.provider, current.model)
  }
  const admitted = await admitDraftImages(segments, deps.attachments)
  return createUserMessage({
    content: [...admitted.blocks],
    source: { kind: 'user' },
  })
}
