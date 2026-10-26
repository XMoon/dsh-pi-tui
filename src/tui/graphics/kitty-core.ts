/**
 * `KittyGraphicsCore` — the single per-physical-terminal owner of Kitty image
 * ids, upload residency, placement validity, retirement and the resident
 * budget (Image-7A PR1).
 *
 * The Core is Client-local TUI state: it exists for exactly one real
 * `Terminal` lifespan and dies with it. It is NOT an image source cache — the
 * only bytes it retains are already-derived display PNGs the caller handed
 * over, kept solely so a clear can be answered with a re-transmission of the
 * SAME image instead of a reload.
 *
 * Every state transition is driven by the real writer stream:
 * `kitty-terminal.ts` reports what it actually wrote (a placement, a legacy
 * deletion, a destructive clear, a screen-buffer switch) and the Core answers
 * with the bytes to emit. Nothing here may claim an image reached the GUI —
 * a `Terminal.write()` only offers bytes to the sink.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/kitty-core
 */

import { randomInt } from 'node:crypto'
import {
  encodeKittyDeleteImage,
  encodeKittyDeletePlacement,
  encodeKittyTransmit,
} from './kitty-native.ts'

/**
 * The physical screen buffer an occurrence was placed in. Kitty keeps the main
 * and the alternate screen's images in separate stores, so a destructive event
 * (or a global delete) only ever concerns the buffer it happened in.
 */
export type KittyScreenBuffer = 'main' | 'alt'

/** The already-prepared display PNG one managed occurrence paints. */
export interface KittyImageSource {
  /** Base64 PNG payload (already transcoded by the existing image owners). */
  readonly pngBase64: string
  readonly widthPx: number
  readonly heightPx: number
}

/** One managed image: a stable id + placement id for one display occurrence. */
export interface KittyImage {
  readonly imageId: number
  readonly placementId: number
  /** Monotonic per-Core generation: a retired id is never re-used. */
  readonly generation: number
}

/** Diagnostic events (the Stage-0 harness and the owner tests read these). */
export interface KittyGraphicsEvent {
  readonly type:
    | 'register'
    | 'budget-fallback'
    | 'transmit-offered'
    | 'placement-written'
    | 'data-invalidated'
    | 'retire-queued'
    | 'retire-emitted'
    | 'write-failed'
    | 'retained'
    | 'writer-delete-translated'
    | 'global-delete-translated'
    | 'shutdown-unplaced'
  readonly imageId?: number
  readonly detail?: string
}

export interface KittyGraphicsCoreOptions {
  /** Diagnostic sink; never required for correctness. */
  readonly onEvent?: (event: KittyGraphicsEvent) => void
}

/**
 * The frozen PR1 budget (plan §4.2). Beyond it a NEW occurrence must fall back
 * to text and no old image is force-deleted: an already-painted image may
 * still be referenced by the screen or the scrollback.
 */
export const MAX_RESIDENT_IMAGES = 32
export const MAX_RESIDENT_PAYLOAD_BYTES = 64 * 1024 * 1024
export const MAX_RESIDENT_DECODED_BYTES = 256 * 1024 * 1024

interface OwnedRecord {
  readonly image: KittyImage
  /** Screen buffers whose store currently holds this image's data: Kitty keeps
   *  the main and the alternate screen's images apart, so the SAME id needs one
   *  transmission per buffer it is placed in. */
  readonly residentIn: Set<KittyScreenBuffer>
  /** The already-prepared payload, or undefined once the occurrence was
   *  retained (the terminal keeps the pixels; this Core releases its copy). */
  source: KittyImageSource | undefined
  /** Whether the payload was ever offered to the sink. */
  transmitted: boolean
  /** The buffer the LAST placement was written into. */
  buffer: KittyScreenBuffer | undefined
  /** Placements written since the last residency invalidation. */
  placements: number
  /** Whether this occurrence ever reached a placement in its lifetime. */
  everPlaced: boolean
  retireQueued: boolean
  /** A retire has been offered to the sink but the write has not succeeded. */
  retirePending: boolean
}

function decodedBytes(source: KittyImageSource): number {
  return source.widthPx * source.heightPx * 4
}

/**
 * The per-Terminal image ledger. One instance per real `Terminal`; never a
 * process-global singleton.
 */
export class KittyGraphicsCore {
  private readonly records = new Map<number, OwnedRecord>()
  /** Every id this Core ever handed out: never reused, and a legacy writer's
   *  late delete for one of them must not be mistaken for a foreign owner. */
  private readonly usedImageIds = new Set<number>()
  /** Ids whose data this Core already freed. */
  private readonly retiredImageIds = new Set<number>()
  private readonly onEvent: ((event: KittyGraphicsEvent) => void) | undefined
  private nextPlacementId = 1
  private generationCounter = 0
  private payloadBytes = 0
  private decodedByteTotal = 0
  private disposed = false

  constructor(options: KittyGraphicsCoreOptions = {}) {
    this.onEvent = options.onEvent
  }

  /**
   * How many image ids this terminal's ledger holds: live payload holders AND
   * painted occurrences the terminal retains. This is the number the frozen
   * ID budget bounds — a retained id still occupies both the terminal's image
   * store and a ledger slot, so it may not be silently grandfathered forever.
   */
  get residentImageCount(): number {
    return this.records.size
  }

  /** The retained base64 payload total (diagnostics + budget tests). */
  get residentPayloadBytes(): number {
    return this.payloadBytes
  }

  /** The retained decoded footprint estimate (diagnostics + budget tests). */
  get residentDecodedBytes(): number {
    return this.decodedByteTotal
  }

  /**
   * Register one display occurrence.
   *
   * Returns `undefined` when the frozen budget cannot admit it: the caller
   * MUST paint its text fallback, never a fake image line. Registration never
   * writes to the terminal.
   */
  register(source: KittyImageSource): KittyImage | undefined {
    if (this.disposed) return undefined
    if (this.records.size + 1 > MAX_RESIDENT_IMAGES
      || this.payloadBytes + source.pngBase64.length > MAX_RESIDENT_PAYLOAD_BYTES
      || this.decodedByteTotal + decodedBytes(source) > MAX_RESIDENT_DECODED_BYTES) {
      this.emit({ type: 'budget-fallback' })
      return undefined
    }
    const imageId = this.allocateImageId()
    const image: KittyImage = {
      imageId,
      placementId: this.nextPlacementId++,
      generation: ++this.generationCounter,
    }
    this.records.set(imageId, {
      image,
      source,
      residentIn: new Set(),
      transmitted: false,
      buffer: undefined,
      placements: 0,
      everPlaced: false,
      retireQueued: false,
      retirePending: false,
    })
    this.payloadBytes += source.pngBase64.length
    this.decodedByteTotal += decodedBytes(source)
    this.emit({ type: 'register', imageId })
    return image
  }

  /** Whether `imageId` belongs to this Core (never a foreign owner's id). */
  owns(imageId: number): boolean {
    return this.records.has(imageId)
  }

  /**
   * Whether `imageId` was ONE OF THIS CORE'S ids and its data is already gone.
   * A late legacy delete for such an id is a no-op, not a foreign command: the
   * Core already retired at the only moment that was allowed to.
   */
  wasOwned(imageId: number): boolean {
    return this.retiredImageIds.has(imageId)
  }

  /**
   * The wire the facade must emit immediately BEFORE a placement of
   * `imageId`: the full quiet transmission when the current buffer no longer
   * holds the data, otherwise an empty string. Transmitting is the only way
   * to make a placement valid, so the record is optimistically marked resident
   * here — the caller may only skip this call when it will not write the
   * placement.
   */
  transmissionFor(imageId: number, buffer: KittyScreenBuffer): string {
    const record = this.records.get(imageId)
    if (record === undefined || record.source === undefined) return ''
    if (record.residentIn.has(buffer)) return ''
    this.emit({ type: 'transmit-offered', imageId, detail: buffer })
    record.residentIn.add(buffer)
    record.transmitted = true
    return encodeKittyTransmit(record.source.pngBase64, imageId).join('')
  }

  /** The facade wrote a placement anchor for this owned image in `buffer`. */
  notePlacement(imageId: number, buffer: KittyScreenBuffer): void {
    const record = this.records.get(imageId)
    if (record === undefined) return
    record.buffer = buffer
    record.placements += 1
    record.everPlaced = true
    this.emit({ type: 'placement-written', imageId, detail: buffer })
  }

  /**
   * End one owned occurrence.
   *
   * A NEVER-painted occurrence is a pure pending byte set: it is queued for its
   * own hard `d=I`, flushed by the next {@link drain} (never from inside a
   * render pass, so every write still travels through the facade's ordered
   * stream) because no screen or scrollback can reference it.
   *
   * A PAINTED occurrence is terminal-retained instead: its pixels may still be
   * visible in the viewport or in the scrollback, and nothing but the screen's
   * own layout may take them away. The Core drops its payload copy (bounding
   * its own memory) and keeps the id known — never re-used, and never
   * hard-deleted by this Core.
   */
  retire(image: KittyImage): void {
    const record = this.records.get(image.imageId)
    if (record === undefined || record.retireQueued || record.retirePending || record.source === undefined) return
    if (record.everPlaced) {
      this.payloadBytes -= record.source.pngBase64.length
      this.decodedByteTotal -= decodedBytes(record.source)
      record.source = undefined
      this.emit({ type: 'retained', imageId: image.imageId })
      return
    }
    record.retireQueued = true
    this.emit({ type: 'retire-queued', imageId: image.imageId })
  }

  /**
   * A legacy writer asked to delete an id the Core owns (the fork's main
   * screen per-id delete). That request carries LAYOUT intent, not ownership:
   * the Core removes the placement so the pixels really disappear in this
   * frame, and keeps the data for a later re-show. Only the Core itself may
   * free the data.
   */
  translateWriterDelete(imageId: number): string {
    const record = this.records.get(imageId)
    if (record === undefined) return ''
    record.placements = 0
    this.emit({ type: 'writer-delete-translated', imageId })
    return encodeKittyDeletePlacement(imageId)
  }

  /**
   * A legacy global placement delete (`d=a`) in `buffer` — translate it into
   * scoped placement removals for the Core images THIS buffer placed. A foreign
   * owner's placements, and the other buffer's images, are never touched: the
   * main screen's scrollback outlives a leased alternate screen.
   */
  translateGlobalPlacementDelete(buffer: KittyScreenBuffer): string {
    let wire = ''
    for (const record of this.records.values()) {
      if (record.buffer !== buffer) continue
      record.placements = 0
      wire += encodeKittyDeletePlacement(record.image.imageId)
    }
    if (wire !== '') this.emit({ type: 'global-delete-translated', detail: `placements:${buffer}` })
    return wire
  }

  /**
   * A legacy global image delete (`d=A`) — translate it into scoped hard
   * retirements of the Core's own images. The records survive (their
   * components still hold them) and the next placement re-transmits.
   */
  translateGlobalImageDelete(buffer: KittyScreenBuffer): string {
    let wire = ''
    for (const [imageId, record] of this.records) {
      // Only the data THIS buffer holds can be released: a record that was
      // never transmitted here has nothing to delete, and the other buffer's
      // copy (the main screen's scrollback) must survive.
      if (!record.residentIn.delete(buffer)) continue
      record.placements = 0
      wire += encodeKittyDeleteImage(record.image.imageId)
      // A painted occurrence the terminal retained is now provably gone: the
      // buffer that held the only copy has just released it, so its id can be
      // retired from the ledger and its slot reused.
      if (record.source === undefined && record.residentIn.size === 0) {
        this.records.delete(imageId)
        this.retiredImageIds.add(imageId)
      }
    }
    if (wire !== '') this.emit({ type: 'global-delete-translated', detail: `images:${buffer}` })
    return wire
  }

  /**
   * A destructive event in `buffer` (a real clear, or that buffer being
   * discarded) invalidated the uploaded data of the images it placed. Nothing
   * is written here: the next placement re-transmits first. Images placed in
   * the OTHER buffer are untouched — a leased alternate screen never costs the
   * main screen its data.
   */
  invalidateResidency(buffer: KittyScreenBuffer, reason: string): void {
    let invalidated = 0
    for (const record of this.records.values()) {
      if (!record.residentIn.delete(buffer)) continue
      record.placements = 0
      invalidated += 1
    }
    if (invalidated > 0) this.emit({ type: 'data-invalidated', detail: `${reason}:${buffer}` })
  }

  /**
   * The queued own-ID deletions, offered to the sink but NOT yet committed: a
   * failing write must be able to put them back, because `Terminal.write()` is
   * only an offer — it never proves the terminal decoded the command.
   */
  takeRetirements(): { wire: string; ids: readonly number[] } {
    const ids: number[] = []
    let wire = ''
    for (const [imageId, record] of this.records) {
      if (!record.retireQueued) continue
      record.retireQueued = false
      record.retirePending = true
      ids.push(imageId)
      wire += encodeKittyDeleteImage(imageId)
    }
    return { wire, ids }
  }

  /** The retire write succeeded: the ids are gone and their bytes are freed. */
  commitRetirements(ids: readonly number[]): void {
    for (const imageId of ids) {
      const record = this.records.get(imageId)
      if (record === undefined) continue
      this.records.delete(imageId)
      this.retiredImageIds.add(imageId)
      if (record.source !== undefined) {
        this.payloadBytes -= record.source.pngBase64.length
        this.decodedByteTotal -= decodedBytes(record.source)
      }
      this.emit({ type: 'retire-emitted', imageId })
    }
  }

  /** The retire write failed: keep the ids queued for the next attempt. */
  rollbackRetirements(ids: readonly number[]): void {
    for (const imageId of ids) {
      const record = this.records.get(imageId)
      if (record === undefined) continue
      record.retirePending = false
      record.retireQueued = true
    }
  }

  /**
   * A frame write threw. The bytes may have partially reached the sink, so the
   * residency of every image this write touched in `buffer` is now UNKNOWN:
   * the next placement must re-send the payload, and nothing may claim the data
   * arrived. Nothing is hard-deleted here — a partially painted image may still
   * be referenced by the screen or the scrollback.
   */
  noteWriteFailure(ids: readonly number[], buffer: KittyScreenBuffer): void {
    let touched = 0
    for (const imageId of ids) {
      const record = this.records.get(imageId)
      if (record === undefined) continue
      record.residentIn.delete(buffer)
      touched += 1
    }
    this.emit({ type: 'write-failed', detail: `${buffer}:${touched}` })
  }

  /**
   * Terminal stop: retire every owned image whose data never reached a
   * placement. Those bytes are invisible and nothing can legitimately
   * reference them, so freeing them cannot erase a scrollback pixel. Images
   * that WERE placed are left to the owner policy the screen already
   * expressed (the alternate screen emits its own global release before the
   * terminal stops; the main screen deliberately preserves its scrollback).
   */
  shutdownUnplaced(): string {
    let wire = ''
    for (const [imageId, record] of this.records) {
      if (record.everPlaced || record.retireQueued || record.source === undefined) continue
      wire += encodeKittyDeleteImage(imageId)
      this.records.delete(imageId)
      this.retiredImageIds.add(imageId)
      this.payloadBytes -= record.source.pngBase64.length
      this.decodedByteTotal -= decodedBytes(record.source)
      this.emit({ type: 'shutdown-unplaced', imageId })
    }
    return wire
  }

  /** Drop every reference. No terminal IO: the terminal is already gone. */
  dispose(): void {
    this.disposed = true
    this.records.clear()
    this.payloadBytes = 0
    this.decodedByteTotal = 0
  }

  private allocateImageId(): number {
    // Node CSPRNG in [1, 0x100000000]; a retired id is never handed out again
    // inside this Core's lifetime, so an old scrollback image can never be
    // adopted by a new occurrence.
    for (;;) {
      const candidate = randomInt(1, 0x100000000)
      if (this.usedImageIds.has(candidate)) continue
      this.usedImageIds.add(candidate)
      return candidate
    }
  }

  private emit(event: KittyGraphicsEvent): void {
    this.onEvent?.(event)
  }
}
