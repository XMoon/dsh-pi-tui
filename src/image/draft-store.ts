/**
 * The per-TUI draft image registry (plan M1, §5.2).
 *
 * Holds staged clipboard/file bytes under numeric ids, mirroring kimi's
 * `ImageAttachmentStore` UX. The store is a MEMORY registry only: it never
 * writes durable attachments (that is `ctx.attachments.saveImages()`), and
 * `clear()` never touches anything the harness already accepted — a cleared
 * draft leaves durable refs unreachable-but-alive per harness retention
 * semantics (plan §14).
 *
 * Bounded (plan §21): a per-draft byte cap and an aggregate byte cap reject
 * new drafts before they are staged, so repeated `/image`/Ctrl+V pastes can
 * never pin unbounded memory in the TUI.
 * @module @xmoon76/dsh-pi-tui/image/draft-store
 */

import { ImageAdmissionError, ImageTooLargeError } from './errors.ts'
import { formatImagePlaceholder } from './placeholder.ts'
import type { DraftImage, DraftImageId, DraftImageInput } from './types.ts'

/** In-memory draft registry. */
export class DraftImageStore {
  private nextId: DraftImageId = 1
  private readonly images = new Map<DraftImageId, DraftImage>()
  private bytesHeld = 0
  private readonly maxImages: number
  private readonly maxBytes: number

  /**
   * TUI-OWNED memory protection, NOT an attachment limit: the caps bound
   * what the TUI stages in RAM before submission (review finding). The
   * harness's `imageLimits` (20 images / 200 MiB per message by default)
   * is a SEPARATE policy enforced at admission; a draft rejected here can
   * still be valid for the backend once submitted in smaller batches.
   * @param maxImages - entry cap (default 16).
   * @param maxBytes - aggregate encoded-byte cap (default 64 MiB). */
  constructor(maxImages = 16, maxBytes = 64 * 1024 * 1024) {
    // Explicit fields (Node strip-only mode rejects parameter properties).
    this.maxImages = maxImages
    this.maxBytes = maxBytes
  }

  /** Stage one image and return its draft (ids increment from 1).
   * @throws ImageTooLargeError when the aggregate cap would be exceeded;
   *   ImageAdmissionError when the entry cap is reached. */
  add(input: DraftImageInput): DraftImage {
    if (this.images.size >= this.maxImages) {
      throw new ImageAdmissionError(
        `Too many staged images: the draft holds ${this.images.size} (limit ${this.maxImages}). Send or remove one first.`,
      )
    }
    if (this.bytesHeld + input.bytes.byteLength > this.maxBytes) {
      throw new ImageTooLargeError(input.bytes.byteLength, this.maxBytes - this.bytesHeld)
    }
    const id = this.nextId++
    const image: DraftImage = {
      id,
      kind: 'image',
      source: input.source ?? { type: 'clipboard' },
      bytes: input.bytes,
      mediaType: input.mediaType,
      width: input.width,
      height: input.height,
      byteLength: input.bytes.byteLength,
      ...(input.name !== undefined ? { name: input.name } : {}),
      placeholder: formatImagePlaceholder(id, input.width, input.height),
    }
    this.images.set(id, image)
    this.bytesHeld += image.byteLength
    return image
  }

  /** The staged draft for an id, or undefined when unknown/removed. */
  get(id: DraftImageId): DraftImage | undefined {
    return this.images.get(id)
  }

  /** Remove one draft; returns whether it was staged. */
  remove(id: DraftImageId): boolean {
    const image = this.images.get(id)
    if (image === undefined) return false
    this.bytesHeld -= image.byteLength
    return this.images.delete(id)
  }

  /** Drop every staged draft (submit, /clear, session switch, dispose). */
  clear(): void {
    this.images.clear()
    this.bytesHeld = 0
  }

  /** All staged drafts in insertion order. */
  values(): readonly DraftImage[] {
    return [...this.images.values()]
  }

  /** How many drafts are staged. */
  size(): number {
    return this.images.size
  }

  /** Aggregate staged bytes (observability/tests). */
  bytes(): number {
    return this.bytesHeld
  }
}
