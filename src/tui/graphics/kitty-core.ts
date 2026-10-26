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
  readonly source: KittyImageSource
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
  /** Bytes were offered to the sink for the CURRENT screen buffer and no
   *  destructive event has invalidated them since. */
  resident: boolean
  /** Whether the payload was ever offered to the sink for a placement. */
  transmitted: boolean
  /** Placements written since the last residency invalidation. */
  placements: number
  /** Whether this occurrence ever reached a placement in its lifetime. */
  everPlaced: boolean
  retireQueued: boolean
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

  /** How many images the ledger currently holds (diagnostics + budget tests). */
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
      source,
    }
    this.records.set(imageId, {
      image,
      resident: false,
      transmitted: false,
      placements: 0,
      everPlaced: false,
      retireQueued: false,
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
  transmissionFor(imageId: number): string {
    const record = this.records.get(imageId)
    if (record === undefined) return ''
    if (record.resident) return ''
    this.emit({ type: 'transmit-offered', imageId })
    record.resident = true
    record.transmitted = true
    return encodeKittyTransmit(record.image.source.pngBase64, imageId).join('')
  }

  /** The facade wrote a placement anchor for this owned image. */
  notePlacement(imageId: number): void {
    const record = this.records.get(imageId)
    if (record === undefined) return
    record.placements += 1
    record.everPlaced = true
    this.emit({ type: 'placement-written', imageId })
  }

  /**
   * Queue the retirement of one owned occurrence. The hard `d=I` is emitted by
   * the next {@link drain} — never from inside a render pass — so every write
   * still travels through the facade's ordered stream.
   */
  retire(image: KittyImage): void {
    const record = this.records.get(image.imageId)
    if (record === undefined || record.retireQueued) return
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
   * A legacy global placement delete (`d=a`) — translate it into scoped
   * placement removals for the Core's own images only. A foreign owner's
   * placements are never touched.
   */
  translateGlobalPlacementDelete(): string {
    let wire = ''
    for (const record of this.records.values()) {
      record.placements = 0
      wire += encodeKittyDeletePlacement(record.image.imageId)
    }
    if (wire !== '') this.emit({ type: 'global-delete-translated', detail: 'placements' })
    return wire
  }

  /**
   * A legacy global image delete (`d=A`) — translate it into scoped hard
   * retirements of the Core's own images. The records survive (their
   * components still hold them) and the next placement re-transmits.
   */
  translateGlobalImageDelete(): string {
    let wire = ''
    for (const record of this.records.values()) {
      record.resident = false
      record.placements = 0
      // A record whose bytes never left this process has nothing to release:
      // emitting its id would only put a command on the wire that cannot
      // affect any pixel.
      if (!record.everPlaced && !record.transmitted) continue
      wire += encodeKittyDeleteImage(record.image.imageId)
    }
    if (wire !== '') this.emit({ type: 'global-delete-translated', detail: 'images' })
    return wire
  }

  /**
   * A destructive screen event (a real clear, or a screen-buffer switch)
   * invalidated the uploaded data of every owned image. Nothing is written
   * here: the next placement re-transmits first.
   */
  invalidateResidency(reason: string): void {
    let invalidated = 0
    for (const record of this.records.values()) {
      record.placements = 0
      if (!record.resident) continue
      record.resident = false
      invalidated += 1
    }
    if (invalidated > 0) this.emit({ type: 'data-invalidated', detail: reason })
  }

  /** Emit (and clear) every queued own-ID deletion, in queue order. */
  drain(): string {
    let wire = ''
    for (const [imageId, record] of this.records) {
      if (record.retireQueued) {
        wire += encodeKittyDeleteImage(imageId)
        this.records.delete(imageId)
        this.retiredImageIds.add(imageId)
        this.payloadBytes -= record.image.source.pngBase64.length
        this.decodedByteTotal -= decodedBytes(record.image.source)
        this.emit({ type: 'retire-emitted', imageId })
        continue
      }
    }
    return wire
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
      if (record.everPlaced || record.retireQueued) continue
      wire += encodeKittyDeleteImage(imageId)
      this.records.delete(imageId)
      this.retiredImageIds.add(imageId)
      this.payloadBytes -= record.image.source.pngBase64.length
      this.decodedByteTotal -= decodedBytes(record.image.source)
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
