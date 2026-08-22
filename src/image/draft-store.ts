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
import { expandImagePlaceholders, formatImagePlaceholder } from './placeholder.ts'
import type { DraftImage, DraftImageId, DraftImageInput } from './types.ts'

/** In-memory draft registry. */
export class DraftImageStore {
  private nextId: DraftImageId = 1
  private readonly images = new Map<DraftImageId, DraftImage>()
  private bytesHeld = 0
  private readonly maxImages: number
  private readonly maxBytes: number
  /**
   * In-flight submission reservations (review finding 1): ids referenced by
   * a submission that STARTED but has not committed yet. The editor is
   * cleared before dispatch, so an attach-time prune would otherwise delete
   * the very drafts the in-flight prepareUserMessage still needs. A pinned
   * draft survives pruning until its submission settles.
   */
  private readonly pins = new Map<DraftImageId, number>()

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
   * @throws ImageTooLargeError when the aggregate RESIDENT cap would be
   *   exceeded; ImageAdmissionError when the entry cap is reached. A
   *   RECALLED input (`recalledRef` present) carries no local bytes: its
   *   LOGICAL size (the durable ref's recorded bytes) counts toward the
   *   message aggregate, but its RESIDENT size is 0 — the bytes live in
   *   harness storage, so the TUI RAM budget never counts them (review
   *   finding 3). */
  add(input: DraftImageInput): DraftImage {
    if (this.images.size >= this.maxImages) {
      throw new ImageAdmissionError(
        `Too many staged images: the draft holds ${this.images.size} (limit ${this.maxImages}). Send or remove one first.`,
      )
    }
    const recalled = input.recalledRef
    const bytes = input.bytes ?? new Uint8Array(0)
    const logicalByteLength = recalled !== undefined ? recalled.bytes : bytes.byteLength
    // Resident = local bytes only; recalled images hold none.
    const residentBytes = bytes.byteLength
    if (this.bytesHeld + residentBytes > this.maxBytes) {
      throw new ImageTooLargeError(residentBytes, this.maxBytes - this.bytesHeld)
    }
    const id = this.nextId++
    const image: DraftImage = {
      id,
      kind: 'image',
      source: recalled !== undefined
        ? { type: 'recalled' }
        : (input.source ?? { type: 'clipboard' }),
      bytes,
      mediaType: input.mediaType,
      width: input.width,
      height: input.height,
      byteLength: logicalByteLength,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(recalled !== undefined ? { recalledRef: recalled } : {}),
      placeholder: formatImagePlaceholder(id, input.width, input.height),
    }
    this.images.set(id, image)
    this.bytesHeld += residentBytes
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
    this.bytesHeld -= image.bytes.byteLength
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

  /** Aggregate RESIDENT staged bytes (observability/tests; recalled
   * images hold no local bytes and count 0). */
  bytes(): number {
    return this.bytesHeld
  }

  /** The remaining RESIDENT byte budget (review finding: used as the
   * intake's extra pre-read safety cap, so a file that could never fit the
   * draft store is refused before any read). */
  remainingBytes(): number {
    return Math.max(0, this.maxBytes - this.bytesHeld)
  }

  /**
   * Reserve every draft referenced by `text` for the duration of one
   * in-flight submission (review finding 1): the editor is cleared before
   * dispatch, so without a reservation an attach-time prune could delete
   * the drafts the submission is about to admit. The returned release
   * function MUST be called (idempotent; safe in finally).
   * @param text - the submitted text (placeholders already expanded).
   * @returns the release function.
   */
  pinReferenced(text: string): () => void {
    const ids: DraftImageId[] = []
    for (const segment of expandImagePlaceholders(text, this)) {
      if (segment.type !== 'image') continue
      const id = segment.image.id
      if (!this.images.has(id)) continue
      this.pins.set(id, (this.pins.get(id) ?? 0) + 1)
      ids.push(id)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const id of ids) {
        const count = this.pins.get(id)
        if (count === undefined) continue
        if (count <= 1) this.pins.delete(id)
        else this.pins.set(id, count - 1)
      }
    }
  }

  /** Whether a draft is reserved by an in-flight submission. */
  isPinned(id: DraftImageId): boolean {
    return (this.pins.get(id) ?? 0) > 0
  }
}
