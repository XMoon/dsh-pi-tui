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
 *
 * Two independent protections may keep one staged image alive:
 * - `submission` pins: the existing business in-flight attachment lifecycle
 *   (`pinDraftAttachments`/`runReservedSubmit`), never evicted by any budget;
 * - `undo` leases: the image can still return through the HOST EDITOR's Undo
 *   history. A lease is keyed by (stable owner, image id) and is therefore
 *   idempotent across `x → Undo → x`; it ends when the owner's real Undo
 *   history stops referencing the image or is retired. The Store owns the
 *   bytes/budget/lease bookkeeping; the Editor owns the snapshot
 *   truth and exposes a narrow retirement callback (fork X064).
 * @module @xmoon76/dsh-pi-tui/client/media/image/draft-store
 */

import { ImageAdmissionError, ImageTooLargeError } from '../../../domain/media/errors.ts'
import { formatImagePlaceholder } from './placeholder.ts'
import type { DraftImage, DraftImageId, DraftImageInput } from './types.ts'

/** One stable Editor Undo-history owner. The host registers the fork Editor
 *  (the only owner whose snapshots can be inspected and retired); the Store
 *  keeps the leases and calls the owner's retirement callback when the
 *  bounded undo-retention budget evicts an image. */
interface DraftImageUndoOwnerState {
  readonly ids: Set<DraftImageId>
  retireDraftImage(placeholder: string): void
}

interface DraftImagePinState {
  submission: number
  undo: number
}

/** The narrow undo-lease capability the PiTui composer consumes. The
 *  Client-local `DraftImageStore` is the production implementation; the port
 *  keeps `TuiApp` free of the store's attachment authority. */
export interface DraftImageUndoLeasePort {
  /** Register one stable Editor owner and the retirement callback the store
   *  calls when the bounded undo-retention budget evicts an image. */
  registerUndoOwner(owner: object, retireDraftImage: (placeholder: string) => void): void
  /** The owner's real Undo history was retired: release its leases. */
  releaseUndoForOwner(owner: object): void
  /** Converge the owner's leases to the placeholders its Undo snapshots still
   *  reference. */
  reconcileUndoOwner(owner: object, placeholders: ReadonlySet<string>): void
}

/** In-memory draft registry. */
export class DraftImageStore {
  private nextId: DraftImageId = 1
  private readonly images = new Map<DraftImageId, DraftImage>()
  private bytesHeld = 0
  private readonly maxImages: number
  private readonly maxBytes: number
  private readonly maxUndoImages: number
  private readonly maxUndoBytes: number
  /** Pin counts per staged image. */
  private readonly pins = new Map<DraftImageId, DraftImagePinState>()
  /** Oldest-first order of undo-leased ids for bounded eviction. */
  private readonly undoRetentionOrder: DraftImageId[] = []
  /** Canonical placeholder -> staged id (strict token resolution only). */
  private readonly placeholderIds = new Map<string, DraftImageId>()
  /** Registered Undo-history owners and the ids each one may still restore. */
  private readonly undoOwners = new Map<object, DraftImageUndoOwnerState>()
  /** Reads the LIVE composer draft (expanded text). Whether an image counts as
   *  ACTIVE or as retention-only is derived from the images this text really
   *  references, never from the pin kind alone: an image restored by Undo is a
   *  live draft attachment again. */
  private liveDraftText: (() => string) | undefined

  /**
   * TUI-OWNED memory protection, NOT an attachment limit: the caps bound
   * what the TUI stages in RAM before submission (review finding). The
   * harness's `imageLimits` (20 images / 200 MiB per message by default)
   * is a SEPARATE policy enforced at admission; a draft rejected here can
   * still be valid for the backend once submitted in smaller batches.
   * @param maxImages - active entry cap (default 16).
   * @param maxBytes - active aggregate encoded-byte cap (default 64 MiB).
   * @param maxUndoImages - bounded undo-retention entries (default 8).
   * @param maxUndoBytes - bounded undo-retention bytes (default 32 MiB). */
  constructor(
    maxImages = 16,
    maxBytes = 64 * 1024 * 1024,
    maxUndoImages = 8,
    maxUndoBytes = 32 * 1024 * 1024,
  ) {
    // Explicit fields (Node strip-only mode rejects parameter properties).
    this.maxImages = maxImages
    this.maxBytes = maxBytes
    this.maxUndoImages = maxUndoImages
    this.maxUndoBytes = maxUndoBytes
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
    const recalled = input.recalledRef
    const bytes = input.bytes ?? new Uint8Array(0)
    const logicalByteLength = recalled !== undefined ? recalled.bytes : bytes.byteLength
    // Resident = local bytes only; recalled images hold none.
    const residentBytes = bytes.byteLength
    // Active admission is INDEPENDENT of undo retention: retention-only
    // drafts do not consume the active caps, so evicting them can never make
    // room for a new active image. A failed add must never destroy existing
    // Undo history.
    const activeSize = this.activeSize()
    if (activeSize >= this.maxImages) {
      throw new ImageAdmissionError(
        `Too many staged images: the draft holds ${activeSize} (limit ${this.maxImages}). Send or remove one first.`,
      )
    }
    if (this.activeBytes() + residentBytes > this.maxBytes) {
      throw new ImageTooLargeError(residentBytes, this.maxBytes - this.activeBytes())
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
    this.placeholderIds.set(image.placeholder, id)
    this.bytesHeld += residentBytes
    return image
  }

  /** The staged draft for an id, or undefined when unknown/removed. */
  get(id: DraftImageId): DraftImage | undefined {
    return this.images.get(id)
  }

  /** Remove one draft; returns whether it was staged. */
  remove(id: DraftImageId): boolean {
    return this.forgetImage(id)
  }

  /** Remove an id and every pin/lease/order entry for it. */
  private forgetImage(id: DraftImageId): boolean {
    const image = this.images.get(id)
    if (image === undefined) return false
    this.bytesHeld -= image.bytes.byteLength
    this.images.delete(id)
    this.placeholderIds.delete(image.placeholder)
    this.pins.delete(id)
    const orderIndex = this.undoRetentionOrder.indexOf(id)
    if (orderIndex >= 0) this.undoRetentionOrder.splice(orderIndex, 1)
    for (const owner of this.undoOwners.values()) owner.ids.delete(id)
    return true
  }

  /** Drop every staged draft (TUI dispose / full teardown). */
  clear(): void {
    this.images.clear()
    this.bytesHeld = 0
    // Full teardown: in-flight pins are meaningless for drafts that no
    // longer exist — drop them so stale entries never linger.
    this.pins.clear()
    this.undoRetentionOrder.length = 0
    this.placeholderIds.clear()
    this.undoOwners.clear()
  }

  /**
   * Drop every staged draft EXCEPT those reserved by an in-flight
   * submission or still referenced by the LIVE editor draft (session switch,
   * /new, /fork — review finding). The PiTui editor deliberately RETAINS its
   * main draft across a committed switch, so dropping a live image's bytes
   * would leave a dead placeholder token in the retained draft. A stale
   * submission that detects the switch likewise still restores its editor
   * text, so its pinned drafts stay until the pin releases.
   */
  clearUnpinned(): void {
    const live = this.liveIds()
    for (const [id, image] of this.images) {
      if (this.isPinned(id) || live.has(id)) continue
      this.bytesHeld -= image.bytes.byteLength
      this.images.delete(id)
      this.placeholderIds.delete(image.placeholder)
      for (const owner of this.undoOwners.values()) owner.ids.delete(id)
    }
  }

  /** All staged drafts in insertion order. */
  values(): readonly DraftImage[] {
    return [...this.images.values()]
  }

  /** How many drafts are staged (active + undo-retained). */
  size(): number {
    return this.images.size
  }

  /** How many drafts count against the ACTIVE cap: every staged image the
   *  live draft references, plus every image that is not undo-retained at
   *  all. An Undo-restored placeholder therefore counts as active again. */
  activeSize(): number {
    const live = this.liveIds()
    let count = 0
    for (const [id] of this.images) {
      if (!this.isRetentionOnly(id, live)) count += 1
    }
    return count
  }

  /** How many undo-retained images occupy the retention budget: only those the
   *  live draft no longer references. */
  undoRetainedCount(): number {
    const live = this.liveIds()
    let count = 0
    for (const [id] of this.images) {
      if (this.isRetentionOnly(id, live)) count += 1
    }
    return count
  }

  /** Register the live composer draft reader (expanded text). */
  setLiveDraftTextSource(read: () => string): void {
    this.liveDraftText = read
  }

  /**
   * Register one stable Editor Undo-history owner (the host fork Editor) with
   * the narrow callback that trims its snapshots when this store evicts a
   * retained image. Registration is per owner object; the callback is the
   * OWNER's, never the currently seated editor's.
   */
  registerUndoOwner(owner: object, retireDraftImage: (placeholder: string) => void): void {
    const existing = this.undoOwners.get(owner)
    if (existing !== undefined) {
      existing.retireDraftImage = retireDraftImage
      return
    }
    this.undoOwners.set(owner, { ids: new Set(), retireDraftImage })
  }

  /**
   * The owner's real Undo history was retired (the fork Editor's
   * onUndoHistoryRetired): every lease it held is released immediately —
   * independent of backend accepted/working state. Bytes that are still live
   * in the draft or submission-pinned stay staged.
   */
  releaseUndoForOwner(owner: object): void {
    const state = this.undoOwners.get(owner)
    if (state === undefined) return
    for (const id of [...state.ids]) this.releaseUndoLease(state, id)
  }

  /**
   * Converge one owner's undo leases to the canonical image placeholders its
   * Undo snapshots still reference. Idempotent: only the (owner, image) delta
   * changes anything, so `x → Undo → x` cannot multiply leases. Live images
   * may keep their lease — Active/retention classification is derived from the
   * live expanded draft, not from the lease itself.
   *
   * This is also the ONE budget-convergence point: every host-editor mutation
   * and every retirement ends here, so an image that leaves the live draft
   * becomes retention-only without any second `removed` ledger.
   */
  reconcileUndoOwner(owner: object, placeholders: ReadonlySet<string>): void {
    const state = this.undoOwners.get(owner)
    // A cleared/never-registered owner holds no stake in any staged bytes
    // (leases only exist through a registered owner), so there is nothing to
    // converge during teardown ordering.
    if (state === undefined) return
    const referenced = new Set<DraftImageId>()
    for (const placeholder of placeholders) {
      const id = this.placeholderIds.get(placeholder)
      if (id !== undefined) referenced.add(id)
    }
    for (const id of [...state.ids]) {
      if (referenced.has(id)) continue
      this.releaseUndoLease(state, id)
    }
    for (const id of referenced) {
      if (state.ids.has(id)) continue
      this.leaseUndo(state, id)
    }
    // The live draft may have changed even when the lease set did not: an
    // already-leased image can LEAVE the draft (typing/x/setText), turning it
    // retention-only and potentially exceeding the budget. `enforce` is a
    // no-op (no live scan) when no undo lease exists at all.
    this.enforceUndoRetentionBudget()
  }

  private leaseUndo(state: DraftImageUndoOwnerState, id: DraftImageId): void {
    state.ids.add(id)
    let pin = this.pins.get(id)
    if (pin === undefined) {
      pin = { submission: 0, undo: 0 }
      this.pins.set(id, pin)
    }
    pin.undo += 1
  }

  private releaseUndoLease(state: DraftImageUndoOwnerState, id: DraftImageId): void {
    if (!state.ids.delete(id)) return
    const pin = this.pins.get(id)
    if (pin === undefined) return
    pin.undo = Math.max(0, pin.undo - 1)
    if (pin.undo === 0) {
      const orderIndex = this.undoRetentionOrder.indexOf(id)
      if (orderIndex >= 0) this.undoRetentionOrder.splice(orderIndex, 1)
    }
    if (pin.submission === 0 && pin.undo === 0) this.pins.delete(id)
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
    return Math.max(0, this.maxBytes - this.activeBytes())
  }

  /**
   * Reserve every live draft referenced by `text` for one in-flight
   * submission (the existing `pinDraftAttachments` lifecycle). Submission
   * pins are never evicted by the undo-retention budget.
   * @param text - the submitted/removed text (placeholders expanded).
   * @returns idempotent release.
   */
  pinReferenced(text: string): () => void {
    const ids: DraftImageId[] = []
    for (const id of this.referencedIds(text)) {
      let pin = this.pins.get(id)
      if (pin === undefined) {
        pin = { submission: 0, undo: 0 }
        this.pins.set(id, pin)
      }
      pin.submission += 1
      ids.push(id)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const id of ids) {
        const pin = this.pins.get(id)
        if (pin === undefined) continue
        pin.submission = Math.max(0, pin.submission - 1)
        if (pin.submission === 0 && pin.undo === 0) this.pins.delete(id)
      }
      // A business release can make a previously protected retention-only
      // image evictable: re-converge the budget now that the pin is gone.
      this.enforceUndoRetentionBudget()
    }
  }

  /** Whether a draft is reserved by any pin (submission or undo lease). */
  isPinned(id: DraftImageId): boolean {
    const state = this.pins.get(id)
    return state !== undefined && (state.submission > 0 || state.undo > 0)
  }

  /** Undo-leased AND no longer referenced by the live draft. */
  private isRetentionOnly(id: DraftImageId, live: ReadonlySet<DraftImageId>): boolean {
    const state = this.pins.get(id)
    return state !== undefined && state.undo > 0 && !live.has(id)
  }

  /** Ids the live expanded draft currently references. */
  private liveIds(): Set<DraftImageId> {
    if (this.liveDraftText === undefined) return new Set()
    return this.referencedIds(this.liveDraftText())
  }

  /** Staged ids whose canonical placeholder occurs in `text`. The strict
   *  placeholder lookup is the ONE resolution authority (never a loose
   *  parser). */
  private referencedIds(text: string): Set<DraftImageId> {
    const ids = new Set<DraftImageId>()
    for (const [placeholder, id] of this.placeholderIds) {
      if (text.includes(placeholder)) ids.add(id)
    }
    return ids
  }

  private activeBytes(): number {
    const live = this.liveIds()
    let bytes = 0
    for (const [id, image] of this.images) {
      if (!this.isRetentionOnly(id, live)) bytes += image.bytes.byteLength
    }
    return bytes
  }

  private undoRetainedBytes(): number {
    const live = this.liveIds()
    let bytes = 0
    for (const [id, image] of this.images) {
      if (this.isRetentionOnly(id, live)) bytes += image.bytes.byteLength
    }
    return bytes
  }

  /** Whether any staged draft carries an undo lease (cheap gate before the
   *  live-draft scan). */
  private hasUndoLease(): boolean {
    for (const pin of this.pins.values()) {
      if (pin.undo > 0) return true
    }
    return false
  }

  /**
   * Keep `undoRetentionOrder` equal to the images that are undo-leased AND no
   * longer live, ordered by the moment each BECAME retention-only (the oldest
   * removal is evicted first, not the oldest document position).
   */
  private syncUndoRetentionOrder(live: ReadonlySet<DraftImageId>): void {
    for (let index = this.undoRetentionOrder.length - 1; index >= 0; index -= 1) {
      const id = this.undoRetentionOrder[index]!
      const pin = this.pins.get(id)
      if (pin !== undefined && pin.undo > 0 && !live.has(id)) continue
      this.undoRetentionOrder.splice(index, 1)
    }
    for (const [id] of this.images) {
      const pin = this.pins.get(id)
      if (pin === undefined || pin.undo <= 0 || live.has(id)) continue
      if (!this.undoRetentionOrder.includes(id)) this.undoRetentionOrder.push(id)
    }
  }

  private retentionCount(live: ReadonlySet<DraftImageId>): number {
    let count = 0
    for (const [id] of this.images) {
      if (this.isRetentionOnly(id, live)) count += 1
    }
    return count
  }

  private retentionBytes(live: ReadonlySet<DraftImageId>): number {
    let bytes = 0
    for (const [id, image] of this.images) {
      if (this.isRetentionOnly(id, live)) bytes += image.bytes.byteLength
    }
    return bytes
  }

  /** Retire the oldest undo-retained draft whose owner snapshots can be
   *  trimmed. Submission pins and live-draft occurrences are never evicted;
   *  the owning Editor trims EVERY snapshot that could restore the image
   *  BEFORE the bytes are dropped. */
  private evictOldestUndoRetention(live: ReadonlySet<DraftImageId>): boolean {
    for (const id of this.undoRetentionOrder) {
      const pin = this.pins.get(id)
      if (pin === undefined || pin.undo <= 0 || pin.submission > 0) continue
      const image = this.images.get(id)
      if (image === undefined || live.has(id)) continue
      for (const owner of this.undoOwners.values()) {
        if (!owner.ids.has(id)) continue
        owner.retireDraftImage(image.placeholder)
      }
      this.forgetImage(id)
      return true
    }
    return false
  }

  /** Keep the retention budget bounded; leave any overage that has no
   *  evictable victim (all remaining occurrences are live in the draft or
   *  in-flight). No undo lease at all is the common no-image/no-history case:
   *  the live draft is not even scanned. */
  private enforceUndoRetentionBudget(): void {
    if (!this.hasUndoLease()) {
      this.undoRetentionOrder.length = 0
      return
    }
    const live = this.liveIds()
    this.syncUndoRetentionOrder(live)
    while (
      this.retentionCount(live) > this.maxUndoImages
      || this.retentionBytes(live) > this.maxUndoBytes
    ) {
      if (!this.evictOldestUndoRetention(live)) return
    }
  }
}
