/**
 * Harness attachment admission (plan M4, §10-§11): draft segments →
 * `ctx.attachments.saveImages()` → `ContentBlock[]`.
 *
 * The TUI NEVER re-implements normalization, transcoding or provider
 * projection — it batches the referenced images through the attachment
 * service and maps the returned refs back onto ordered content blocks.
 * Structural types keep this module testable without the dsh runtime
 * (AGENTS.md decision 7); `ImageMediaType`/`ImageAttachmentRef`/`ContentBlock`
 * shapes are verified against `@deepseek-ai/dsh-attachment` 0.1.1-rc.1.
 * @module @xmoon76/dsh-pi-tui/image/admission
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ImageAdmissionError } from './errors.ts'
import type { DraftSegment } from './placeholder.ts'
import type { ImageMediaType } from './types.ts'

/** Structural subset of `@deepseek-ai/dsh-attachment`'s `SaveImageAttachment`. */
export interface SaveImageAttachmentLike {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly name?: string
}

/** Structural subset of `ImageAttachmentRef`. */
export interface ImageAttachmentRefLike {
  readonly attachmentId: string
  readonly mediaType: ImageMediaType
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** Structural subset of the `ctx.attachments` service surface. */
export interface AttachmentsLike {
  readonly imageLimits: {
    readonly maxImageBytes: number
    readonly maxImagesPerMessage: number
    readonly maxMessageImageBytes: number
    readonly maxImagePixels: number
    readonly maxImageDimension: number
    readonly mediaTypes: readonly ImageMediaType[]
  }
  saveImages(inputs: readonly SaveImageAttachmentLike[]): Promise<readonly ImageAttachmentRefLike[]>
}

/** The admission outcome: ordered content blocks + the durable refs. */
export interface AdmittedContent {
  /** Blocks in exact draft order (text/image interleaving preserved, §11). */
  readonly blocks: readonly ContentBlock[]
  /** The durable refs in input order (parallel to the image segments). */
  readonly refs: readonly ImageAttachmentRefLike[]
}

/** Total encoded bytes of the referenced images (preflight input). */
export function imageSegmentsBytes(segments: readonly DraftSegment[]): number {
  let total = 0
  for (const segment of segments) {
    if (segment.type === 'image') total += segment.image.byteLength
  }
  return total
}

/**
 * Build the ordered `ContentBlock[]` for one draft (plan §11): every text
 * segment becomes a text block, every image segment an image block backed by
 * the durable refs (index-aligned with the image segments in order). Empty
 * text segments were already dropped by the placeholder expansion.
 * @param segments - the expanded draft segments.
 * @param refs - durable refs in image-segment order.
 */
export function buildContentBlocks(
  segments: readonly DraftSegment[],
  refs: readonly ImageAttachmentRefLike[],
): readonly ContentBlock[] {
  const blocks: ContentBlock[] = []
  let refIndex = 0
  for (const segment of segments) {
    if (segment.type === 'text') {
      if (segment.text !== '') blocks.push({ type: 'text', text: segment.text })
      continue
    }
    const ref = refs[refIndex]
    if (ref === undefined) {
      throw new ImageAdmissionError('An image draft could not be admitted (reference mismatch).')
    }
    refIndex += 1
    blocks.push({ type: 'image', attachment: ref as never })
  }
  return blocks
}

/**
 * Admit every staged image of a draft (plan §10.2): one batched
 * `saveImages()` keeps input/ref ordering and avoids half-success semantics.
 * Count/aggregate preflights come from the LIVE `imageLimits`; the harness
 * re-validates bytes at admission — the TUI never duplicates normalization.
 * @param segments - the expanded draft segments.
 * @param attachments - the live `ctx.attachments` service.
 * @returns the admitted blocks and refs.
 */
export async function admitDraftImages(
  segments: readonly DraftSegment[],
  attachments: AttachmentsLike,
): Promise<AdmittedContent> {
  const images = segments.filter((segment): segment is Extract<DraftSegment, { type: 'image' }> =>
    segment.type === 'image')
  if (images.length === 0) {
    return { blocks: buildContentBlocks(segments, []), refs: [] }
  }
  const limits = attachments.imageLimits
  if (images.length > limits.maxImagesPerMessage) {
    throw new ImageAdmissionError(
      `Too many images: ${images.length} attached, the current limit is ${limits.maxImagesPerMessage} per message.`,
    )
  }
  const aggregate = imageSegmentsBytes(images)
  if (aggregate > limits.maxMessageImageBytes) {
    throw new ImageAdmissionError(
      `Images total ${aggregate} bytes; the current aggregate limit is ${limits.maxMessageImageBytes} bytes.`,
    )
  }
  const refs = await attachments.saveImages(images.map(image => ({
    data: image.image.bytes,
    mediaType: image.image.mediaType,
    ...(image.image.name !== undefined ? { name: image.image.name } : {}),
  })))
  if (refs.length !== images.length) {
    // The service's contract is input-order-aligned refs; a mismatch means
    // the blocks would silently diverge from the images (round-2 finding 6).
    throw new ImageAdmissionError(
      `The attachment service returned ${refs.length} references for ${images.length} images.`,
    )
  }
  return { blocks: buildContentBlocks(segments, refs), refs }
}
