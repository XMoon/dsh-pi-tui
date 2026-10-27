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

/**
 * How the placement reaches the outer terminal. `native` is a cursor-positioned
 * placement in the terminal's own image store (one store per screen buffer).
 * `tmux-virtual` is a Unicode-placeholder prototype: the single outer image
 * namespace is shared by both screen buffers and the image moves with the text
 * cells, so residency is one slot and writer deletes are layout intent only.
 */
export type KittyPlacementMode = 'native' | 'tmux-virtual'

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
  readonly imageId?: number
  readonly detail?: string
}

export interface KittyGraphicsCoreOptions {
  /** Diagnostic sink; never required for correctness. */
  readonly onEvent?: (event: KittyGraphicsEvent) => void
  /** Placement transport; `native` (default) keeps the Image-7A contract. */
  readonly placementMode?: KittyPlacementMode
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
 * This Core hands out a CONTIGUOUS, forward-only id range starting at a random
 * offset in the lower half of the 32-bit space. Ownership is then decidable in
 * O(1) from two numbers, with no per-image bookkeeping and no session-long id
 * set:
 *
 * - every id in `[floor, next)` is this Core's, forever — including an
 *   occurrence whose pixels the terminal retained after it went away — so a
 *   late legacy writer delete can never be mistaken for a foreign command and
 *   can never free those pixels;
 * - the range never wraps (`next` simply stops), so a historical id is NEVER
 *   re-used and a new occurrence can never adopt old pixels;
 * - a foreign owner's id is outside the range with probability
 *   `1 - allocated/2^32`, so its per-id commands pass through byte-for-byte.
 *   A genuine numeric collision is possible in principle (the plan forbids
 *   claiming a mathematical zero); it would run the placement-removal part of
 *   the same request for the foreign owner — its visible effect is preserved,
 *   only the data-free would not be performed on its behalf.
 *
 * The range starts in the lower half so a session has at least 2^31 ids before
 * the space is exhausted (an unreachable number: exhaustion falls back to
 * text). Allocation is deliberately not CSPRNG-per-id: the anti-reuse guarantee
 * must be exact, and it is, without keeping every historical id.
 */
const ID_SPACE_START_LIMIT = 0x80000000

/** A planned (not yet committed) global image delete for one screen buffer. */
export interface KittyGlobalImageDeletePlan {
  readonly buffer: KittyScreenBuffer
  readonly wire: string
  /** Live records whose data for `buffer` the write will release. */
  readonly released: ReadonlyArray<{ readonly imageId: number; readonly record: OwnedRecord }>
  /** Retained alt-session ids the write will release (no record left). */
  readonly retained: readonly number[]
}

export interface OwnedRecord {
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
  /**
   * Every id placed in the CURRENT alternate session, including occurrences
   * that were already retired (their pixels are terminal-retained). The
   * alternate screen owns exactly these on the way out, and the set dies with
   * that session, so it can never grow with the main screen's history.
   */
  private readonly altSessionIds = new Set<number>()
  /** The first id this Core ever handed out (a random start). */
  private readonly imageIdFloor = randomInt(1, ID_SPACE_START_LIMIT)
  /** One past the last id handed out: `[floor, next)` is exactly this Core's. */
  private nextImageId = this.imageIdFloor
  private readonly onEvent: ((event: KittyGraphicsEvent) => void) | undefined
  private readonly placementMode: KittyPlacementMode
  private nextPlacementId = 1
  private generationCounter = 0
  private payloadBytes = 0
  private decodedByteTotal = 0
  private disposed = false

  constructor(options: KittyGraphicsCoreOptions = {}) {
    this.onEvent = options.onEvent
    this.placementMode = options.placementMode ?? 'native'
  }

  /**
   * The residency key. The Native backend stores data per screen buffer; the
   * virtual backend has ONE outer image namespace for the whole tmux pane, so
   * both buffers share the single slot and a screen switch never discards it.
   */
  private residencySlot(buffer: KittyScreenBuffer): KittyScreenBuffer {
    return this.placementMode === 'tmux-virtual' ? 'main' : buffer
  }

  /** How many occurrences currently hold a payload (the budgeted active set). */
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
    if (this.payloadBytes + source.pngBase64.length > MAX_RESIDENT_PAYLOAD_BYTES
      || this.decodedByteTotal + decodedBytes(source) > MAX_RESIDENT_DECODED_BYTES) {
      this.emit({ type: 'budget-fallback' })
      return undefined
    }
    const imageId = this.allocateImageId()
    if (imageId === undefined) {
      this.emit({ type: 'budget-fallback', detail: 'id-space' })
      return undefined
    }
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
      everPlaced: false,
      retireQueued: false,
      retirePending: false,
    })
    this.payloadBytes += source.pngBase64.length
    this.decodedByteTotal += decodedBytes(source)
    this.emit({ type: 'register', imageId })
    return image
  }

  /** Whether `imageId` is a live occurrence that can receive a placement. */
  owns(imageId: number): boolean {
    return this.records.has(imageId)
  }

  /**
   * Whether `imageId` was EVER this Core's. True for a live occurrence and for
   * one whose pixels the terminal retained after the occurrence went away:
   * both are inside the reserved id slice, so this stays exact with no
   * per-image bookkeeping and no session-long id set.
   */
  ownsIdSpace(imageId: number): boolean {
    return imageId >= this.imageIdFloor && imageId < this.nextImageId
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
    const slot = this.residencySlot(buffer)
    if (record.residentIn.has(slot)) return ''
    this.emit({ type: 'transmit-offered', imageId, detail: buffer })
    record.residentIn.add(slot)
    record.transmitted = true
    return encodeKittyTransmit(record.source.pngBase64, imageId).join('')
  }

  /** The facade wrote a placement anchor for this owned image in `buffer`. */
  notePlacement(imageId: number, buffer: KittyScreenBuffer): void {
    const record = this.records.get(imageId)
    if (record === undefined) return
    record.buffer = buffer
    if (buffer === 'alt') this.altSessionIds.add(imageId)
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
      // The pixels are the terminal's now. The id needs no record: it lives in
      // the reserved slice, so a late writer delete is still recognised as a
      // placement removal and the id is never handed out again.
      this.records.delete(image.imageId)
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
    if (this.placementMode === 'tmux-virtual') {
      // A writer delete is the text frame saying "this cell is gone now". In
      // the virtual backend the real placeholder cells are what hides the
      // image, so a hard/placement delete here would reach old scrollback
      // prototypes that still refer to the same image data. Translate to no
      // bytes at all; only the Core's own retire writes a delete.
      return ''
    }
    const record = this.records.get(imageId)
    if (record !== undefined) {
      this.emit({ type: 'writer-delete-translated', imageId })
      return encodeKittyDeletePlacement(imageId)
    }
    if (!this.ownsIdSpace(imageId)) return ''
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
    if (this.placementMode === 'tmux-virtual') {
      // Global forms (`d=a` / bare `a=d`) never affect a virtual prototype and
      // may never be used to hide text-driven images; the erased cells do that.
      return ''
    }
    let wire = ''
    for (const record of this.records.values()) {
      if (record.buffer !== buffer) continue
      wire += encodeKittyDeletePlacement(record.image.imageId)
    }
    if (buffer === 'alt') {
      // A repaint clear in the alternate buffer must also remove the
      // placement of an occurrence that was retired after it painted: the
      // screen no longer has a record for it, but the pixels are still on
      // that buffer, and erasing text does not erase graphics. Its data stays
      // resident (the session's own release frees it), so this is a scoped
      // placement removal, exactly like the live case.
      for (const imageId of this.altSessionIds) {
        if (this.records.has(imageId)) continue
        wire += encodeKittyDeletePlacement(imageId)
      }
    }
    if (wire !== '') this.emit({ type: 'global-delete-translated', detail: `placements:${buffer}` })
    return wire
  }

  /**
   * PLAN a legacy global image delete (`d=A`): the scoped hard deletions of the
   * Core's own ids, plus the ownership that releasing them will consume.
   *
   * Nothing is mutated here. `Terminal.write()` is an offer, not an ACK, so the
   * ownership may only be consumed once the sink accepted the bytes — a failing
   * write must leave every id RETRYABLE. The facade pairs this with
   * {@link commitGlobalImageDelete}.
   */
  planGlobalImageDelete(buffer: KittyScreenBuffer): KittyGlobalImageDeletePlan {
    if (this.placementMode === 'tmux-virtual') {
      // Invisible prototypes have no physical location, so a writer's global
      // image delete cannot be re-scoped to them; it is layout intent only.
      return { buffer, wire: '', released: [], retained: [] }
    }
    const released: Array<{ imageId: number; record: OwnedRecord }> = []
    const retained: number[] = []
    let wire = ''
    for (const [imageId, record] of this.records) {
      // Only the data THIS buffer holds can be released: a record that was
      // never transmitted here has nothing to delete, and the other buffer's
      // copy (the main screen's scrollback) must survive.
      if (!record.residentIn.has(buffer)) continue
      released.push({ imageId, record })
      wire += encodeKittyDeleteImage(imageId)
    }
    if (buffer === 'alt') {
      // An occurrence that was placed in the alternate buffer and then retired
      // left `records`, but its pixels were still that screen's to release.
      // They can only live in that buffer (an occurrence is placed on ONE
      // screen), so the alternate screen's own exit frees them by id.
      for (const imageId of this.altSessionIds) {
        if (this.records.has(imageId)) continue
        retained.push(imageId)
        wire += encodeKittyDeleteImage(imageId)
      }
    }
    return { buffer, wire, released, retained }
  }

  /**
   * The global delete write was accepted: consume exactly what the plan
   * released. A no-op plan (nothing resident in that buffer) is fine to commit.
   */
  commitGlobalImageDelete(plan: KittyGlobalImageDeletePlan): void {
    for (const entry of plan.released) entry.record.residentIn.delete(plan.buffer)
    if (plan.buffer === 'alt') {
      for (const imageId of plan.retained) this.altSessionIds.delete(imageId)
    }
    if (plan.wire !== '') {
      this.emit({ type: 'global-delete-translated', detail: `images:${plan.buffer}` })
    }
  }

  /**
   * A new alternate session starts: nothing it placed before is its to release
   * any more. Separate from {@link invalidateResidency}, because an ordinary
   * clear INSIDE a session invalidates residency without ending the session —
   * ids that session painted stay its own until the session ends.
   */
  beginAltSession(): void {
    this.altSessionIds.clear()
  }

  /** The alternate buffer is gone: its placement ownership dies with it. */
  endAltSession(): void {
    this.altSessionIds.clear()
  }

  /**
   * A destructive event in `buffer` (a real clear, or that buffer being
   * discarded) invalidated the uploaded data of the images it placed. Nothing
   * is written here: the next placement re-transmits first. Images placed in
   * the OTHER buffer are untouched — a leased alternate screen never costs the
   * main screen its data.
   */
  invalidateResidency(buffer: KittyScreenBuffer, reason: string): void {
    const slot = this.residencySlot(buffer)
    let invalidated = 0
    for (const record of this.records.values()) {
      if (!record.residentIn.delete(slot)) continue
      invalidated += 1
    }
    if (invalidated > 0) this.emit({ type: 'data-invalidated', detail: `${reason}:${buffer}` })
  }

  /**
   * Whether any own-ID retirement is waiting to be offered. The tmux facade
   * must know this BEFORE it writes: a queued retirement makes the next write a
   * managed batch that has to pass admission, and a revoked handle may not
   * send those old IDs to a different client.
   */
  hasQueuedRetirements(): boolean {
    for (const record of this.records.values()) {
      if (record.retireQueued) return true
    }
    return false
  }

  /**
   * Release every queued, NEVER-PAINTED retirement WITHOUT terminal IO.
   *
   * Only a revoked tmux handle uses this: its old ids must not be sent to
   * whatever client is attached now, and the bytes were never placed, so no
   * screen or scrollback can reference them. The outer terminal may keep the
   * abandoned upload (invisible, with no placements); the Core releases its own
   * payload and record locally. A PAINTED occurrence is never affected.
   */
  discardQueuedRetirements(): void {
    for (const [imageId, record] of this.records) {
      if (!record.retireQueued || record.source === undefined) continue
      this.payloadBytes -= record.source.pngBase64.length
      this.decodedByteTotal -= decodedBytes(record.source)
      this.records.delete(imageId)
    }
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
    const slot = this.residencySlot(buffer)
    let touched = 0
    for (const imageId of ids) {
      const record = this.records.get(imageId)
      if (record === undefined) continue
      record.residentIn.delete(slot)
      touched += 1
    }
    this.emit({ type: 'write-failed', detail: `${buffer}:${touched}` })
  }


  /** Drop every reference. No terminal IO: the terminal is already gone. */
  dispose(): void {
    this.disposed = true
    this.records.clear()
    this.altSessionIds.clear()
    this.payloadBytes = 0
    this.decodedByteTotal = 0
  }

  /**
   * The next id in the reserved slice: a forward-only counter from a random
   * start, so a historical id is never re-used within a process lifetime. The
   * only rejection is a live occurrence (the counter wrapped after more than a
   * million images, which no real session can reach); exhaustion fails closed.
   */
  private allocateImageId(): number | undefined {
    // The range never wraps: a historical id can never come back, at the cost
    // of falling back to text once the 32-bit space above the floor is spent.
    if (this.nextImageId > 0xffffffff) return undefined
    const imageId = this.nextImageId
    this.nextImageId += 1
    return imageId
  }

  private emit(event: KittyGraphicsEvent): void {
    this.onEvent?.(event)
  }
}
