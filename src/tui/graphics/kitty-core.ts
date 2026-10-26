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
 * The frozen ACTIVE-SET budget (plan §4.2, amended by the Owner 2026-10-27).
 *
 * These bound the working set the Core itself manages — pending uploads and the
 * re-transmittable PNG cache — NOT how many images a session ever displayed.
 * A meaningfully sized image whose decoded footprint alone exceeds the decoded
 * budget is refused, and a new occurrence falls back to text when the active
 * set is full; a previously PAINTED image is never force-deleted on its
 * account. There is deliberately no cumulative image-id count: the main screen
 * keeps its scrollback, so session-long id growth is terminal-retained and
 * bounded by the terminal, not by a Core quota.
 */
export const MAX_RESIDENT_PAYLOAD_BYTES = 64 * 1024 * 1024
export const MAX_RESIDENT_DECODED_BYTES = 256 * 1024 * 1024

/**
 * How many recently retained ids stay recognizable after their occurrence went
 * away. A legacy writer's delete for one of them must stay a scoped placement
 * removal (never a hard delete), and that delete only arrives for a frame that
 * was on screen one or two paints ago. The ring is FIXED size so app-side state
 * never grows with the number of images a session displayed.
 */
const RETAINED_ID_MEMORY = 256

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
  /** The ACTIVE set: occurrences that still hold a payload (the budgeted set). */
  private readonly records = new Map<number, OwnedRecord>()
  /** Bounded memory of ids whose painted pixels the terminal now retains. */
  private readonly retainedIds = new Set<number>()
  private readonly retainedOrder: number[] = []
  private readonly onEvent: ((event: KittyGraphicsEvent) => void) | undefined
  private nextPlacementId = 1
  private generationCounter = 0
  private payloadBytes = 0
  private decodedByteTotal = 0
  private disposed = false

  constructor(options: KittyGraphicsCoreOptions = {}) {
    this.onEvent = options.onEvent
  }

  /** How many occurrences currently hold a payload (the budgeted active set). */
  get residentImageCount(): number {
    return this.records.size
  }

  /** How many recently retained ids the Core still recognizes (bounded). */
  get retainedImageCount(): number {
    return this.retainedIds.size
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
    if (this.payloadBytes + source.pngBase64.length > MAX_RESIDENT_PAYLOAD_BYTES
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

  /**
   * Whether `imageId` belongs to this Core: a live occurrence, or a painted one
   * whose pixels the terminal now retains (still recognized so a late legacy
   * delete stays a scoped placement removal instead of freeing those pixels).
   */
  owns(imageId: number): boolean {
    return this.records.has(imageId) || this.retainedIds.has(imageId)
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
      // The pixels are the terminal's now; the Core keeps no payload and only
      // a BOUNDED id memory so a late writer delete stays a placement removal.
      this.records.delete(image.imageId)
      this.retainedIds.add(image.imageId)
      this.retainedOrder.push(image.imageId)
      if (this.retainedOrder.length > RETAINED_ID_MEMORY) {
        const forgotten = this.retainedOrder.shift()!
        this.retainedIds.delete(forgotten)
      }
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
    if (record !== undefined) {
      record.placements = 0
      this.emit({ type: 'writer-delete-translated', imageId })
      return encodeKittyDeletePlacement(imageId)
    }
    if (!this.retainedIds.has(imageId)) return ''
    // The occurrence is gone but its pixels are terminal-retained: the layout
    // intent is still "remove the placement", never "free the data".
    this.emit({ type: 'writer-delete-translated', imageId, detail: 'retained' })
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
    this.retainedIds.clear()
    this.retainedOrder.length = 0
    this.payloadBytes = 0
    this.decodedByteTotal = 0
  }

  private allocateImageId(): number {
    // Node CSPRNG in [1, 0x100000000]: random ids keep this Core clear of a
    // foreign owner's ids in the same terminal. The draw is rejected against
    // everything the Core still tracks — the live active set and the bounded
    // retained-id memory — so a new occurrence can never adopt an id whose
    // pixels may still be on screen. The check is deliberately bounded: this is
    // exactly the state the Core keeps, not a session-long id ledger.
    for (;;) {
      const candidate = randomInt(1, 0x100000000)
      if (this.records.has(candidate) || this.retainedIds.has(candidate)) continue
      return candidate
    }
  }

  private emit(event: KittyGraphicsEvent): void {
    this.onEvent?.(event)
  }
}
