/**
 * Image-8 / I8-2A — the ONE Client-local Direct SIXEL graphics owner.
 *
 * This module is the only place in the product that turns an authorized PNG
 * into pixels on a SIXEL terminal. It owns four things and nothing else:
 *
 * 1. **Admission.** `canPaint()` answers "may THIS frame paint" from a
 *    per-app readiness projection over three real terminal facts: the passive
 *    DA1 SIXEL attribute (`ProcessTerminal.onSixelSupport`, X071), the real
 *    `CSI 6;h;w t` cell reply the active screen parsed, and the real OSC 11
 *    background. `pending` is not permission: a candidate that has not
 *    answered, a screen that has not reported, or a background observation
 *    that timed out paints text instead. No `9x18` default and no guessed
 *    background is ever substituted for a fact.
 * 2. **Encoding.** ONE {@link SixelEncoder} per app lifetime, so the whole
 *    product holds one encode lane and one worker at a time.
 * 3. **Trust.** A Screen never parses a DCS. The registry below recognises the
 *    EXACT string this owner encoded and reports its real footprint; every
 *    other DCS stays ordinary text. A Screen that needs a shorter raster (a
 *    bottom-clipped block, or an anchor that scrolled above the viewport) asks
 *    for a bounded re-encode of the SAME source — the DCS string is never cut.
 * 4. **Lifetime.** `dispose()` refuses new work synchronously, aborts every
 *    in-flight request, drops the registry and observes the one encoder
 *    disposal through `runDetached` so a worker termination failure is
 *    reported instead of vanishing.
 *
 * Residency follows the physical frame: the registry retains at most
 * {@link SIXEL_REGISTRY_MAX_VARIANTS} encoded rasters, the Screen grants the
 * occurrences its FINAL layout really shows (bottom-up within the budget), and a
 * committed frame releases every record no longer retained. A component never
 * emits a DCS: it emits an inert candidate marker, and `materialize()` is the
 * only token->DCS exit. A frame that really shows more candidates than the
 * budget settles the excess into text deterministically; a record a frame never
 * showed cannot pin the registry, so history can no longer starve a new image.
 *
 * The display derivative is never persisted, transmitted or exported: it is a
 * Client-local projection of bytes the existing `ImageLoader` already
 * authorized.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/sixel-image
 */

import { createHash, randomBytes } from 'node:crypto'
import { getCapabilities, type Terminal, TuiMainScreen } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import { diagFromEnv, type Diag } from '../../runtime/process/diagnostics.ts'
import { observeSettled, runDetached } from '../../runtime/process/tasks.ts'
import { SixelEncoder } from '../../client/media/sixel/encode.ts'
import type { SixelRaster } from '../../client/media/sixel/types.ts'
import { createDirectSixelCapability } from './sixel-capability.ts'
import type { KittyImageSource } from './kitty-core.ts'
import type { NativeKittyImageBody, NativeKittyImageOptions, PixelBody } from './native-image.ts'

/**
 * The SIXEL screen trust port the fork's physical Screen reads (X072).
 *
 * Derived from the screen constructor instead of re-declaring the interface, so
 * the fork stays the single definition of what a Screen may believe.
 */
export type DirectSixelScreenPort = NonNullable<ConstructorParameters<typeof TuiMainScreen>[3]>

/** One visible block the Screen reports for this frame (mirror of X072's shape). */
type ScreenVisibleCandidate = Parameters<DirectSixelScreenPort['reconcileVisible']>[1][number]
/** One raster the physical Screen still shows after a committed write. */
type ScreenFrameRaster = Parameters<DirectSixelScreenPort['framePainted']>[1][number]

/** The one graphics handle a Direct SIXEL app owns per physical terminal. */
export interface DirectSixelGraphics {
  readonly mode: 'sixel'
  readonly terminal: Terminal
  /** The trust port both screens receive. */
  readonly screen: DirectSixelScreenPort
  /** Whether the live readiness projection allows pixels on THIS frame. */
  canPaint(): boolean
  /**
   * Point the readiness projection at the screen that owns the terminal now, or
   * `undefined` to detach. Called on every screen start and on every resize;
   * NEVER from a render.
   */
  observeScreen(observer: SixelScreenObservation | undefined, columns: number, rows: number): void
  /**
   * Re-observe the CURRENT screen's facts without changing the screen binding.
   *
   * A terminal colour-scheme report (mode 2031) or a theme switch can change the
   * real background while the screen and its size stay identical, so neither
   * `observeScreen` nor a resize would notice. Until the new observation
   * completes, no pixels are painted with the old facts.
   */
  resample(): void
  /** Bind one display occurrence. The returned component owns its raster. */
  image(source: KittyImageSource, options: NativeKittyImageOptions): PixelBody
  /** Release the encoder and every registered raster. Idempotent. */
  dispose(): void
}

/** The narrow per-screen surface the readiness projection observes. */
export interface SixelScreenObservation {
  /** Send one `CSI 16t`; refused by a screen that is not started. */
  queryCellSizeForSixel(): void
  /** Observe the screen's ONE real `CSI 6;h;w t` parse. */
  onCellSizeObserved(listener: (cell: { widthPx: number; heightPx: number }) => void): () => void
  /** Observe the real terminal background (OSC 11, coalesced by the screen). */
  queryTerminalBackgroundColor(options: { timeoutMs: number }): Promise<{ r: number; g: number; b: number } | undefined>
}

/** Largest number of encoded DCS variants one app may retain. */
export const SIXEL_REGISTRY_MAX_VARIANTS = 16
/** Largest total encoded DCS payload one app may retain. */
export const SIXEL_REGISTRY_MAX_BYTES = 32 * 1024 * 1024
/** The background observation's own bound (the screen resolves `undefined` past it). */
export const SIXEL_BACKGROUND_QUERY_TIMEOUT_MS = 800
/**
 * How many times one unpaintable/failed encode may be retried before the
 * occurrence settles into text until its facts or the trust table change.
 *
 * Above zero so a transient busy lane recovers on a later frame; finite so a
 * permanent failure cannot re-task the single encoder lane on every repaint.
 */
export const SIXEL_ENCODE_ATTEMPT_LIMIT = 3

/** The verified facts one encode depends on. */
interface VerifiedGeometry {
  readonly cellWidthPx: number
  readonly cellHeightPx: number
  readonly backgroundRgb: number
  /** Bumped whenever the verified fact triple (or the observed screen) changes. */
  readonly epoch: number
}

function backgroundToRgb(color: { r: number; g: number; b: number }): number {
  const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value)))
  return (channel(color.r) << 16) | (channel(color.g) << 8) | channel(color.b)
}

/** One registered encoded raster as the trust port reports it. */
interface RasterRecord {
  readonly dcs: string
  readonly rows: number
  readonly columns: number
  readonly bytes: number
  /**
   * The occurrences painting this raster. Identical sources can encode to the
   * identical DCS, so one record serves several occurrences. Only a record with
   * NO live owner is evictable, and the CURRENT crop of a live occurrence is an
   * owner, so a crop on screen can never be dropped to make room for another.
   */
  readonly owners: Set<Occurrence>
  /** Whether this raster is a full encode or a bounded visible-window variant.
   *  A FULL admission that dedups into an existing crop record upgrades it, so a
   *  picture can never be refused a crop merely because a variant with the same
   *  bytes was registered first. */
  kind: 'full' | 'crop'
  /** Monotonic last-use stamp (registry hits and admission). */
  useStamp: number
}

/** The authorized source bytes one occurrence encodes from. */
interface SourceBinding {
  readonly png: Uint8Array
  /** Identity of the exact source, so a different image can never reuse a raster. */
  readonly identity: string
}

/**
 * One bound occurrence: a stable candidate identity plus the rasters it owns.
 *
 * The identity exists BEFORE any encode: a Screen can only ask the owner about
 * an image it can see through this token, which is what breaks the
 * "encode first, then discover visibility" cycle. `full`/`crop` are filled in
 * as the owner encodes on a granted frame, never merely because a component
 * rendered.
 *
 * `crop` holds at most one CURRENT variant: the one the granted frame asked
 * for. A superseded variant is unregistered when the next window is granted,
 * so a fast scroll back re-encodes instead of projecting a stale crop.
 */
interface Occurrence {
  /** Stable per-occurrence identity (never derived from the DCS). */
  readonly id: string
  /** The inert marker the component emits; resolvable only by exact lookup. */
  readonly token: string
  /** This occurrence's own safe text while no pixels are granted. */
  readonly fallback: string
  /** Conservative layout reserve in cell rows, before a raster exists. */
  readonly layoutRows: number
  /** The component that owns this occurrence's encode lifecycle. */
  readonly image: SixelImage
  /** The exact encode key (source, width, cell box, background, epoch). */
  readonly key: string
  readonly source: SourceBinding
  geometry: VerifiedGeometry
  maxColumns: number
  maxRows: number
  width: number
  /** The current frame grant, or undefined when the occurrence is off screen. */
  grant?: { cropTopRows: number; visibleRows: number }
  /** The last frame in which the Screen really showed this occurrence's pixels. */
  painted?: { width: number; columns: number; rows: number; cropTopRows?: number }
  full?: RasterRecord
  crop?: { cropTopRows: number; visibleRows: number; record: RasterRecord }
  /**
   * The one in-flight variant request. `attempts` carries the SAME window's failure
   * count across retries: the retry path clears `failedCrop` (through `releaseCrop`),
   * so without this the bounded budget would restart at 1 on every attempt.
   */
  pendingCrop?: { cropTopRows: number; visibleRows: number; controller: AbortController; attempts: number }
  /** A visible window this source cannot draw.
   *
   * `terminal` means the outcome is final for these facts (a transparent window,
   * or the bounded retry budget spent). A `refused` outcome (the registry budget)
   * is retried once the trust table's revision changes; a `rejected` one (the lane)
   * is retried until the attempt budget runs out. */
  failedCrop?: {
    cropTopRows: number
    visibleRows: number
    revision: number
    terminal: boolean
    kind: 'refused' | 'rejected'
    attempts: number
  }
}

/** What one {@link SixelImage} render produced. */
interface ReadyEntry {
  readonly key: string
  readonly record: RasterRecord
}

/**
 * Create the ONE Direct SIXEL graphics handle for this app, or `undefined`
 * when the terminal is statically excluded.
 *
 * A statically denied topology (hard-off, explicit legacy protocol, a
 * multiplexer, a terminal the fork already classifies as Kitty/iTerm2) gets NO
 * handle at all: there is then no port, no encoder, no DA1 subscription and no
 * output. An admitted candidate starts `pending` and only becomes paintable
 * once the DA1 attribute, the real cell reply and the real background have all
 * arrived for the CURRENT screen.
 */
export function createDirectSixelGraphics(
  terminal: Terminal,
  environment: NodeJS.ProcessEnv = process.env,
  onReadinessChanged: () => void = () => {},
): DirectSixelGraphics | undefined {
  const capability = createDirectSixelCapability(terminal, environment, getCapabilities().images)
  if (capability.verdict === 'denied') return undefined

  const owner = new DirectSixelGraphicsOwner(terminal, capability, onReadinessChanged)
  return owner
}

/**
 * The Direct SIXEL owner.
 *
 * Not exported as a class: callers get the {@link DirectSixelGraphics} face, so
 * no consumer can reach the encoder, the registry or the readiness projection
 * through an internal type.
 */
class DirectSixelGraphicsOwner implements DirectSixelGraphics {
  readonly mode = 'sixel' as const
  readonly terminal: Terminal
  readonly screen: DirectSixelScreenPort
  private readonly capability: ReturnType<typeof createDirectSixelCapability>
  private readonly encoder = new SixelEncoder()
  private readonly onReadinessChanged: () => void
  private readonly diag: Diag
  /** Monotonic use stamp for the registry's LRU order. */
  private useStamp = 0
  /** Every registered raster, keyed by its exact DCS string. */
  private readonly records = new Map<string, RasterRecord>()
  /** Every live occurrence, so disposal can release all rasters at once. */
  private readonly occurrences = new Set<Occurrence>()
  /** Exact candidate token -> occurrence. The ONLY candidate lookup. */
  private readonly candidates = new Map<string, Occurrence>()
  /** Monotonic occurrence identity (never reused within one app). */
  private occurrenceSeq = 0
  /** Per-owner nonce: a candidate token must not be forgeable by ordinary text. */
  private readonly occurrenceNonce = randomBytes(8).toString('hex')
  /** The current frame's granted occurrences, in bottom-up priority order. */
  private grantOrder: Occurrence[] = []
  private retainedBytes = 0
  /** Bumped on every admission/unregistration, so a REFUSED request can be
   *  retried only when the trust table actually changed. */
  private admissionRevision = 0
  private observer: SixelScreenObservation | undefined
  private detachObserver: (() => void) | undefined
  private observedColumns = 0
  private observedRows = 0
  private epoch = 0
  private cell: { widthPx: number; heightPx: number } | undefined
  private backgroundRgb: number | undefined
  private readyGeometry: VerifiedGeometry | undefined
  private unsubscribeDa1: (() => void) | undefined
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(
    terminal: Terminal,
    capability: ReturnType<typeof createDirectSixelCapability>,
    onReadinessChanged: () => void,
  ) {
    this.terminal = terminal
    this.capability = capability
    this.onReadinessChanged = onReadinessChanged
    this.diag = diagFromEnv(process.env)
    this.screen = {
      footprint: (line: string) => {
        const record = this.records.get(line)
        if (record === undefined) return undefined
        record.useStamp = ++this.useStamp
        return { columns: record.columns, rows: record.rows }
      },
      crop: (line: string, cropTopRows: number, visibleRows: number) =>
        this.cropTrusted(line, cropTopRows, visibleRows),
      candidate: (line: string) => {
        const occurrence = this.candidates.get(line)
        if (occurrence === undefined) return undefined
        return {
          id: occurrence.id,
          fallback: occurrence.fallback,
          layoutRows: occurrence.full?.rows ?? occurrence.layoutRows,
        }
      },
      reconcileVisible: (screen: object, demands: readonly ScreenVisibleCandidate[]) =>
        this.reconcileVisible(screen, demands),
      materialize: (line: string, cropTopRows: number, visibleRows: number) =>
        this.materialize(line, cropTopRows, visibleRows),
      framePainted: (screen: object, retained: readonly ScreenFrameRaster[]) => this.framePainted(screen, retained),
    }
    this.unsubscribeDa1 = terminal.onSixelSupport?.(() => this.capabilityChanged())
    // A late subscriber receives the terminal's already-known DA1 value, so the
    // first admission can arrive here instead of in a render.
    this.capabilityChanged()
  }

  // === readiness ============================================================

  /**
   * Point the readiness projection at the screen that is active NOW.
   *
   * The app calls this on every screen start/stop and on every terminal resize
   * (with the current columns/rows). A stopped or replaced screen is detached
   * first, so a reply that was in flight for the old screen lands in a cleared
   * epoch and cannot certify the new one.
   */
  observeScreen(observer: SixelScreenObservation | undefined, columns: number, rows: number): void {
    if (this.disposed) return
    const sameScreen = observer === this.observer
    const sameSize = columns === this.observedColumns && rows === this.observedRows
    this.detachObserver?.()
    this.detachObserver = undefined
    this.observer = observer
    this.observedColumns = columns
    this.observedRows = rows
    if (observer === undefined) {
      this.invalidateGeometry()
      return
    }
    this.detachObserver = observer.onCellSizeObserved((cell) => this.onCellSize(cell))
    if (this.capability.verdict !== 'admitted') {
      // `pending`/`denied` is not permission: no geometry or background query is
      // spent before the terminal itself declared the SIXEL attribute.
      this.invalidateGeometry()
      return
    }
    if (sameScreen && sameSize && this.readyGeometry !== undefined) return
    // A new screen (or a new terminal size) invalidates the old facts: the next
    // frame must not paint with them.
    this.invalidateGeometry()
    this.sampleGeometry()
  }

  /** Re-observe the current screen's facts (a scheme/theme change). */
  resample(): void {
    if (this.disposed || this.observer === undefined) return
    if (this.capability.verdict !== 'admitted') return
    this.invalidateGeometry()
    this.sampleGeometry()
  }

  /** Whether a consumer may paint pixels on this frame. */
  canPaint(): boolean {
    return !this.disposed && this.readyGeometry !== undefined
  }

  /** The verified facts a new occurrence must encode with, if they are ready. */
  private verifiedGeometry(): VerifiedGeometry | undefined {
    return this.disposed ? undefined : this.readyGeometry
  }

  private capabilityChanged(): void {
    if (this.disposed) return
    if (this.capability.verdict === 'admitted') {
      if (this.observer === undefined) return
      if (this.cell !== undefined && this.backgroundRgb !== undefined) {
        this.commitGeometry()
        return
      }
      this.sampleGeometry()
      return
    }
    // `pending` and `denied` are both "no pixels": a denied DA1 must also stop
    // painting anything the previous admission produced.
    this.invalidateGeometry()
  }

  /**
   * Ask the ACTIVE screen for the two real facts not yet known.
   *
   * Both queries carry no request identity, so every reply is guarded by the
   * epoch it was requested under: a screen handoff, a resize or a stop makes the
   * answer land in a cleared epoch and change nothing.
   */
  private sampleGeometry(): void {
    const observer = this.observer
    if (observer === undefined || this.disposed) return
    const epoch = ++this.epoch
    this.cell = undefined
    this.backgroundRgb = undefined
    observer.queryCellSizeForSixel()
    runDetached(
      'SIXEL terminal background observation',
      async () => {
        const color = await observer.queryTerminalBackgroundColor({ timeoutMs: SIXEL_BACKGROUND_QUERY_TIMEOUT_MS })
        // A late or cross-screen answer must never certify this epoch.
        if (this.disposed || epoch !== this.epoch) return
        this.backgroundRgb = color === undefined ? undefined : backgroundToRgb(color)
        this.commitGeometry()
      },
      { diag: this.diag },
    )
  }

  private onCellSize(cell: { widthPx: number; heightPx: number }): void {
    if (this.disposed || this.observer === undefined) return
    if (!Number.isInteger(cell.widthPx) || !Number.isInteger(cell.heightPx)) return
    if (cell.widthPx <= 0 || cell.heightPx <= 0) return
    // An identical reply is the same fact: it must not restart the projection,
    // or every repeated reply would repaint the whole surface.
    if (this.cell?.widthPx === cell.widthPx && this.cell.heightPx === cell.heightPx) return
    this.cell = { widthPx: cell.widthPx, heightPx: cell.heightPx }
    this.commitGeometry()
  }

  private commitGeometry(): void {
    if (this.disposed) return
    if (this.capability.verdict !== 'admitted') return
    const cell = this.cell
    const backgroundRgb = this.backgroundRgb
    if (cell === undefined || backgroundRgb === undefined) return
    const previous = this.readyGeometry
    if (
      previous !== undefined &&
      previous.cellWidthPx === cell.widthPx &&
      previous.cellHeightPx === cell.heightPx &&
      previous.backgroundRgb === backgroundRgb
    ) {
      return
    }
    this.readyGeometry = {
      cellWidthPx: cell.widthPx,
      cellHeightPx: cell.heightPx,
      backgroundRgb,
      epoch: ++this.epoch,
    }
    // Three trusted facts are now complete for this screen: the consumers that
    // were painting text may paint pixels, and one repaint carries the change.
    this.onReadinessChanged()
  }

  private invalidateGeometry(): void {
    const had = this.readyGeometry !== undefined
    this.readyGeometry = undefined
    this.cell = undefined
    this.backgroundRgb = undefined
    this.epoch += 1
    if (had) this.onReadinessChanged()
  }

  // === trust registry =======================================================

  /** Register one raster, or refuse when every retained variant is in use. */
  private admit(raster: SixelRaster, kind: 'full' | 'crop'): RasterRecord | undefined {
    const existing = this.records.get(raster.sequence)
    if (existing !== undefined) {
      // Two occurrences of the same source encode to the SAME trusted string:
      // one retained payload serves both, and neither pays a second budget slot.
      // A full admission wins the record's kind: "is this a cropable source" must
      // not depend on which occurrence happened to encode those bytes first.
      if (kind === 'full') existing.kind = 'full'
      existing.useStamp = ++this.useStamp
      return existing
    }
    const bytes = Buffer.byteLength(raster.sequence, 'utf8')
    while (
      this.records.size >= SIXEL_REGISTRY_MAX_VARIANTS ||
      this.retainedBytes + bytes > SIXEL_REGISTRY_MAX_BYTES
    ) {
      if (!this.evictOne()) return undefined
    }
    const record: RasterRecord = {
      dcs: raster.sequence,
      rows: raster.rows,
      columns: raster.columns,
      bytes,
      owners: new Set(),
      kind,
      useStamp: ++this.useStamp,
    }
    this.records.set(record.dcs, record)
    this.retainedBytes += bytes
    this.admissionRevision += 1
    return record
  }

  /** Drop the oldest record no live occurrence holds. */
  private evictOne(): boolean {
    let oldest: RasterRecord | undefined
    for (const record of this.records.values()) {
      if (record.owners.size > 0) continue
      if (oldest === undefined || record.useStamp < oldest.useStamp) oldest = record
    }
    if (oldest === undefined) return false
    this.unregister(oldest)
    return true
  }

  private unregister(record: RasterRecord): void {
    if (!this.records.delete(record.dcs)) return
    this.retainedBytes -= record.bytes
    this.admissionRevision += 1
  }

  /**
   * Legacy trust helper retained for the port's `crop()` contract and existing
   * callers: an ALREADY READY variant only. It never starts work — the Screen's
   * materialization path is the only place a visible window is granted.
   */
  private cropTrusted(line: string, cropTopRows: number, visibleRows: number): string | undefined {
    const record = this.records.get(line)
    if (record === undefined) return undefined
    record.useStamp = ++this.useStamp
    if (record.kind !== 'full') return undefined
    const occurrence = record.owners.values().next().value
    if (occurrence === undefined || this.disposed) return undefined
    const full = occurrence.full
    if (full === undefined) return undefined
    if (cropTopRows === 0 && visibleRows >= full.rows) return full.dcs
    const current = occurrence.crop
    if (current !== undefined && current.cropTopRows === cropTopRows && current.visibleRows === visibleRows) {
      if (this.records.get(current.record.dcs) !== current.record) {
        occurrence.crop = undefined
        return undefined
      }
      current.record.useStamp = ++this.useStamp
      return current.record.dcs
    }
    // Legacy direct-crop callers (the DCS trust path the fork fixtures use):
    // schedule the bounded variant exactly once; the Screen repaints on settle.
    occurrence.image.ensureCrop(cropTopRows, visibleRows)
    return undefined
  }

  // === occurrences ==========================================================

  /** Bind one occurrence; the component owns the returned raster handle. */
  image(source: KittyImageSource, options: NativeKittyImageOptions): PixelBody {
    return new SixelImage(this, source, options)
  }

  /** @internal — the encoder face of this owner. */
  get encoderLane(): SixelEncoder {
    return this.encoder
  }

  /** @internal — the verified facts, or undefined while the projection is incomplete. */
  get ready(): VerifiedGeometry | undefined {
    return this.verifiedGeometry()
  }

  /** @internal — bind one candidate identity BEFORE any encode exists. */
  bindOccurrence(
    image: SixelImage,
    source: SourceBinding,
    options: NativeKittyImageOptions,
    geometry: VerifiedGeometry,
    bounds: { width: number; maxColumns: number; maxRows: number; layoutRows: number; key: string },
  ): Occurrence {
    const id = String(++this.occurrenceSeq)
    const occurrence: Occurrence = {
      id,
      token: `\u2063SIXC:${this.occurrenceNonce}:${id}\u2063`,
      fallback: options.fallback,
      layoutRows: bounds.layoutRows,
      image,
      key: bounds.key,
      source,
      geometry,
      maxColumns: bounds.maxColumns,
      maxRows: bounds.maxRows,
      width: bounds.width,
    }
    this.occurrences.add(occurrence)
    this.candidates.set(occurrence.token, occurrence)
    return occurrence
  }

  /**
   * Grant residency to the occurrences the final layout really shows.
   *
   * `screen` must be the SAME object `observeScreen` bound; a late frame from a
   * stale/inactive screen changes nothing. The grant set is the frame's whole
   * visibility truth: occurrences not demanded here lose their grant and are
   * released after the next committed write. Encoding is NOT started here —
   * `framePainted` releases first, then tasks the one lane in bottom-up order.
   */
  private reconcileVisible(screen: object, demands: readonly ScreenVisibleCandidate[]): boolean {
    if (this.disposed || this.observer === undefined || screen !== this.observer) return false
    const wanted = new Map<Occurrence, { cropTopRows: number; visibleRows: number }>()
    // Bottom-up priority is the OWNER's rule, not the caller's: the newest visible
    // content wins a contested slot on every screen.
    const ordered = [...demands].sort((left, right) => right.physicalRow - left.physicalRow)
    for (const demand of ordered) {
      const occurrence = this.candidates.get(demand.line)
      if (occurrence === undefined) continue
      wanted.set(occurrence, { cropTopRows: demand.cropTopRows, visibleRows: demand.visibleRows })
    }
    this.grantOrder = [...wanted.keys()]
    let changed = false
    for (const occurrence of this.occurrences) {
      const grant = wanted.get(occurrence)
      if (grant === undefined) {
        if (occurrence.grant !== undefined) {
          occurrence.grant = undefined
          changed = true
        }
        continue
      }
      if (occurrence.grant?.cropTopRows !== grant.cropTopRows || occurrence.grant.visibleRows !== grant.visibleRows) {
        occurrence.grant = grant
        changed = true
      }
    }
    return changed
  }

  /** Exact DCS for a granted window; never starts work and never accepts an
   *  unregistered request. */
  private materialize(line: string, cropTopRows: number, visibleRows: number): string | undefined {
    const occurrence = this.candidates.get(line)
    if (occurrence === undefined || occurrence.grant === undefined) return undefined
    if (occurrence.grant.cropTopRows !== cropTopRows || occurrence.grant.visibleRows !== visibleRows) return undefined
    return occurrence.image.readyDcs(cropTopRows, visibleRows)
  }

  /**
   * Close one committed frame: release every occurrence that lost its grant,
   * mark what the physical screen still shows, then task the lane for the
   * granted-but-unready occurrences in the caller's bottom-up order.
   */
  private framePainted(screen: object, retained: readonly ScreenFrameRaster[]): void {
    if (this.disposed || this.observer === undefined || screen !== this.observer) return
    const shown = new Map<string, ScreenFrameRaster>()
    for (const raster of retained) shown.set(raster.line, raster)
    // A release needs no extra repaint: the frame being committed already paints
    // the revoked occurrence as text, and any newly granted encode repaints when
    // it settles. (Aborting an in-flight encode is the only side effect here.)
    for (const occurrence of [...this.occurrences]) {
      if (occurrence.grant === undefined) {
        // Idempotent: aborts an in-flight encode too, so an off-screen occurrence
        // can never register a record after its release.
        occurrence.image.releaseRecords()
        continue
      }
      const raster = shown.get(occurrence.token)
      const crop = occurrence.crop
      const record =
        raster === undefined
          ? undefined
          : occurrence.full?.dcs === raster.dcs
            ? occurrence.full
            : crop?.record.dcs === raster.dcs
              ? crop.record
              : undefined
      // The retained raster is the Screen's committed fact: once the exact DCS
      // is verified, the offset comes from THIS frame's raster, never from the
      // owner's current variant (a different window can encode to the same
      // DCS, and the variant may already have advanced past the painted frame).
      const committedCropTopRows = raster?.cropTopRows ?? 0
      occurrence.painted = record === undefined
        ? undefined
        : {
            width: occurrence.width,
            columns: record.columns,
            rows: record.rows,
            ...(committedCropTopRows > 0 ? { cropTopRows: committedCropTopRows } : {}),
          }
    }
    // Bottom-up order is the caller's contract: the newest content wins a
    // contested slot, and every grant beyond the hard budget settles into text.
    for (const occurrence of this.grantOrder) {
      if (occurrence.grant === undefined) continue
      if (occurrence.full === undefined) occurrence.image.ensureFull()
      else occurrence.image.ensureCrop(occurrence.grant.cropTopRows, occurrence.grant.visibleRows)
    }
  }

  /** @internal — drop one occurrence's full/crop records (used on release). */
  releaseOccurrence(occurrence: Occurrence): void {
    const full = occurrence.full
    occurrence.grant = undefined
    occurrence.painted = undefined
    occurrence.full = undefined
    // The crop record still lists this occurrence as an owner: dropping only the
    // field would leave an unevictable phantom that refills the budget on every
    // scroll round-trip.
    this.releaseCropRecords(occurrence)
    if (full === undefined) return
    full.owners.delete(occurrence)
    if (full.owners.size === 0) this.unregister(full)
  }

  /** @internal — drop the current crop variant (a new window is being encoded). */
  releaseCropRecords(occurrence: Occurrence): void {
    const crop = occurrence.crop
    occurrence.crop = undefined
    if (crop === undefined) return
    crop.record.owners.delete(occurrence)
    if (crop.record.owners.size === 0) this.unregister(crop.record)
  }

  /** @internal — register a freshly encoded crop variant. */
  admitCrop(raster: SixelRaster): RasterRecord | undefined {
    return this.admit(raster, 'crop')
  }

  /** @internal — register a freshly encoded FULL raster; the caller marks its owner. */
  admitFull(raster: SixelRaster): RasterRecord | undefined {
    return this.admit(raster, 'full')
  }

  /** @internal — the current trust-table revision (see `admissionRevision`). */
  get registryRevision(): number {
    return this.admissionRevision
  }

  /** @internal — the diagnostics channel every owned async task reports through. */
  get diagnosticSink(): Diag {
    return this.diag
  }

  /** @internal — drop one occurrence and everything it retained. */
  removeOccurrence(occurrence: Occurrence): void {
    if (!this.occurrences.delete(occurrence)) return
    this.candidates.delete(occurrence.token)
    occurrence.pendingCrop?.controller.abort()
    occurrence.pendingCrop = undefined
    this.releaseCropRecords(occurrence)
    const full = occurrence.full
    occurrence.full = undefined
    occurrence.grant = undefined
    occurrence.painted = undefined
    if (full === undefined) return
    full.owners.delete(occurrence)
    if (full.owners.size === 0) this.unregister(full)
  }

  /** @internal — the terminal's current row count, for the raster's row ceiling. */
  get terminalRows(): number {
    return this.terminal.rows
  }

  /** @internal — ask for one repaint (an async settle changed what may be painted). */
  requestRepaint(): void {
    if (!this.disposed) this.onReadinessChanged()
  }

  dispose(): void {
    if (this.disposal !== undefined) return
    // The synchronous half first: no new work, no new pixels, nothing retained.
    this.disposed = true
    this.unsubscribeDa1?.()
    this.unsubscribeDa1 = undefined
    this.detachObserver?.()
    this.detachObserver = undefined
    this.observer = undefined
    this.capability.dispose()
    this.readyGeometry = undefined
    for (const occurrence of [...this.occurrences]) {
      occurrence.pendingCrop?.controller.abort()
      occurrence.pendingCrop = undefined
      occurrence.full?.owners.delete(occurrence)
    }
    this.occurrences.clear()
    this.candidates.clear()
    this.grantOrder = []
    this.records.clear()
    this.retainedBytes = 0
    // The terminal write side is already gone, so the only remaining work is the
    // worker's real termination. It is observed (never a bare `void`), and the
    // diagnostics channel stays open until that observation has settled.
    this.disposal = this.encoder.dispose()
    runDetached('SIXEL encoder disposal', () => this.disposal, { diag: this.diag })
    observeSettled(this.disposal, () => this.diag.dispose())
  }

  /** @internal — the ONE disposal promise (tests await the real worker close). */
  get disposalSettled(): Promise<void> {
    return this.disposal ?? Promise.resolve()
  }
}

/**
 * One display occurrence of a trusted PNG on a SIXEL terminal.
 *
 * The component is a plain `Component`: `render(width)` performs admission and
 * returns either the exact trusted DCS (plus blank body rows) or a one-line
 * styled fallback. It never awaits, never runs `sharp` in the render stack and
 * never writes to the terminal — the async encode settles into a repaint.
 */
class SixelImage implements Component {
  private readonly owner: DirectSixelGraphicsOwner
  private readonly source: SourceBinding
  private readonly options: NativeKittyImageOptions
  private occurrence: Occurrence | undefined
  private inFlight: { key: string; controller: AbortController } | undefined
  /** A request not worth re-sending on every frame; `terminal` means "for these
   *  facts, forever" (a transparent picture or a spent retry budget). */
  private rejected: { key: string; revision: number; terminal: boolean } | undefined
  /** Bounded retries per key: a transient failure may retry, a permanent one may not
   *  spin the single encoder lane forever. */
  private failures: { key: string; attempts: number } | undefined
  private disposed = false

  constructor(owner: DirectSixelGraphicsOwner, source: KittyImageSource, options: NativeKittyImageOptions) {
    this.owner = owner
    this.options = options
    // The union face is shared with the Kitty path, which carries base64. The
    // encoder takes bytes, so the decode happens ONCE per occurrence here. The
    // identity is the digest of those bytes: a prefix/length pair would be a
    // heuristic, and two different pictures sharing one raster is exactly the
    // staleness this registry exists to prevent.
    const png = Buffer.from(source.pngBase64, 'base64')
    this.source = {
      png,
      identity: `${source.widthPx}x${source.heightPx}:${createHash('sha256').update(png).digest('hex')}`,
    }
  }

  /**
   * The real painted footprint at `width`, or `undefined` when the last frame
   * carried no pixels for this occurrence.
   *
   * Only a raster the Screen really materialized and kept in its last committed
   * frame answers: a pending encode, a budget fallback, an overlay-covered block
   * and a released (off-screen) record all paint no body, so a click can never
   * open the Viewer from a row of text.
   */
  paintedBodyAt(width: number): NativeKittyImageBody | undefined {
    const painted = this.occurrence?.painted
    if (painted === undefined || painted.width !== width) return undefined
    return {
      width,
      columns: painted.columns,
      rows: painted.rows,
      ...(painted.cropTopRows === undefined ? {} : { cropTopRows: painted.cropTopRows }),
    }
  }

  /**
   * The component's lines: an inert candidate marker plus its conservative
   * layout reserve, never a DCS.
   *
   * The Screen resolves the marker only after its final layout told the owner
   * which blocks are really visible; until then this line must not claim any
   * pixels. `undefined` means the facts are not verified and the component
   * renders its ordinary fallback.
   */
  candidateLines(width: number): string[] | undefined {
    if (this.disposed) return undefined
    const geometry = this.owner.ready
    if (geometry === undefined) {
      this.dropOccurrence()
      return undefined
    }
    const bounds = this.bounds(geometry, width)
    if (this.occurrence === undefined || this.occurrence.key !== bounds.key) {
      this.dropOccurrence()
      this.occurrence = this.owner.bindOccurrence(this, this.source, this.options, geometry, bounds)
    }
    const occurrence = this.occurrence
    const rows = occurrence.full?.rows ?? occurrence.layoutRows
    const lines = [occurrence.token]
    for (let row = 1; row < rows; row += 1) lines.push('')
    return lines
  }

  render(width: number): string[] {
    if (this.disposed) return [this.options.fallback]
    return this.candidateLines(width) ?? [this.options.fallback]
  }

  /** The PixelBody contract: there is no per-instance frame cache any more —
   *  what paints is decided by the Screen's grant, so a repaint is always safe. */
  invalidate(): void {}


  /** @internal — the DCS for a granted window, or undefined while not ready. */
  readyDcs(cropTopRows: number, visibleRows: number): string | undefined {
    const occurrence = this.occurrence
    if (occurrence === undefined) return undefined
    const full = occurrence.full
    if (full === undefined) return undefined
    if (cropTopRows === 0 && visibleRows >= full.rows) return full.dcs
    const crop = occurrence.crop
    if (crop !== undefined && crop.cropTopRows === cropTopRows && crop.visibleRows === visibleRows) return crop.record.dcs
    return undefined
  }

  /** @internal — a granted occurrence needs its full raster. */
  ensureFull(): void {
    const occurrence = this.occurrence
    if (occurrence === undefined || this.disposed) return
    if (occurrence.full !== undefined) return
    if (this.inFlight?.key === occurrence.key) return
    const rejected = this.rejected
    if (
      rejected !== undefined &&
      rejected.key === occurrence.key &&
      (rejected.terminal || rejected.revision === this.owner.registryRevision)
    ) {
      return
    }
    this.startEncode(occurrence)
  }

  /** @internal — a granted window needs its bounded crop variant. */
  ensureCrop(cropTopRows: number, visibleRows: number): void {
    const occurrence = this.occurrence
    if (occurrence === undefined || this.disposed) return
    const full = occurrence.full
    if (full === undefined) {
      this.ensureFull()
      return
    }
    if (cropTopRows === 0 && visibleRows >= full.rows) return
    const current = occurrence.crop
    if (current !== undefined && current.cropTopRows === cropTopRows && current.visibleRows === visibleRows) return
    const pending = occurrence.pendingCrop
    if (pending !== undefined && pending.cropTopRows === cropTopRows && pending.visibleRows === visibleRows) return
    const failed = occurrence.failedCrop
    if (
      failed !== undefined &&
      failed.cropTopRows === cropTopRows &&
      failed.visibleRows === visibleRows &&
      (failed.terminal || (failed.kind === 'refused' && failed.revision === this.owner.registryRevision))
    ) {
      return
    }
    this.startCropEncode(occurrence, cropTopRows, visibleRows)
  }

  /** @internal — the owner releases the occurrence's records after a frame. */
  releaseRecords(): void {
    this.inFlight?.controller.abort()
    this.inFlight = undefined
    const occurrence = this.occurrence
    if (occurrence === undefined) return
    occurrence.pendingCrop?.controller.abort()
    occurrence.pendingCrop = undefined
    this.owner.releaseOccurrence(occurrence)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.inFlight?.controller.abort()
    this.inFlight = undefined
    this.rejected = undefined
    this.failures = undefined
    this.dropOccurrence()
  }

  private dropOccurrence(): void {
    if (this.occurrence !== undefined) this.owner.removeOccurrence(this.occurrence)
    this.occurrence = undefined
  }

  /**
   * The cell box this occurrence may use at `width`, plus the EXACT key every
   * raster it produces depends on (source, width, cell box, background, epoch).
   *
   * One derivation feeds both the encoder request and the occurrence identity,
   * so a stale composite can never be reused and the two can never drift apart.
   */
  private bounds(geometry: VerifiedGeometry, width: number): { width: number; maxColumns: number; maxRows: number; layoutRows: number; key: string } {
    const maxColumns = Math.max(1, Math.min(width - 2, this.options.maxWidthCells))
    const defaultMaxRows = Math.max(1, Math.ceil((maxColumns * geometry.cellWidthPx) / geometry.cellHeightPx))
    const maxRows = Math.max(
      1,
      Math.min(this.options.maxHeightCells ?? defaultMaxRows, this.owner.terminalRows),
    )
    const key = [
      this.source.identity,
      String(width),
      String(maxColumns),
      String(maxRows),
      String(geometry.cellWidthPx),
      String(geometry.cellHeightPx),
      String(geometry.backgroundRgb),
      String(geometry.epoch),
    ].join('|')
    // The conservative layout reserve: the full picture's height at this width,
    // never more than the granted row ceiling. The real raster height replaces it
    // once an encode settles; it exists only so a Screen can recognize a block
    // whose anchor scrolled above the viewport before any pixels exist.
    const layoutRows = Math.max(1, Math.min(maxRows, defaultMaxRows))
    return { width, maxColumns, maxRows, layoutRows, key }
  }

  private startEncode(occurrence: Occurrence): void {
    const controller = new AbortController()
    this.inFlight = { key: occurrence.key, controller }
    runDetached(
      'SIXEL image encode',
      async () => {
        let raster: SixelRaster | null
        try {
          raster = await this.owner.encoderLane.encode({
            png: this.source.png,
            cellWidthPx: occurrence.geometry.cellWidthPx,
            cellHeightPx: occurrence.geometry.cellHeightPx,
            maxColumns: occurrence.maxColumns,
            maxRows: occurrence.maxRows,
            cropTopRows: 0,
            backgroundRgb: occurrence.geometry.backgroundRgb,
            signal: controller.signal,
          })
        } catch (error) {
          if (this.inFlight?.controller === controller) this.inFlight = undefined
          this.recordFailure(occurrence.key)
          throw error
        }
        if (this.disposed || this.inFlight?.controller !== controller) return
        this.inFlight = undefined
        if (controller.signal.aborted) return
        if (raster === null) {
          this.rejected = { key: occurrence.key, revision: this.owner.registryRevision, terminal: true }
          return
        }
        if (this.owner.ready?.epoch !== occurrence.geometry.epoch) return
        const record = this.owner.admitFull(raster)
        if (record === undefined) {
          // The hard budget is exhausted by rasters the CURRENT frame keeps. The
          // occurrence stays text until the trust table changes; the Screen's next
          // committed frame may release a record and grant it again.
          this.rejected = { key: occurrence.key, revision: this.owner.registryRevision, terminal: false }
          return
        }
        record.owners.add(occurrence)
        occurrence.full = record
        this.owner.requestRepaint()
      },
      { diag: this.owner.diagnosticSink },
    )
  }

  private startCropEncode(occurrence: Occurrence, cropTopRows: number, visibleRows: number): void {
    occurrence.pendingCrop?.controller.abort()
    this.owner.releaseCropRecords(occurrence)
    const controller = new AbortController()
    const failed = occurrence.failedCrop
    const carried = failed !== undefined && failed.cropTopRows === cropTopRows && failed.visibleRows === visibleRows ? failed.attempts : 0
    occurrence.pendingCrop = { cropTopRows, visibleRows, controller, attempts: carried }
    runDetached(
      'SIXEL crop variant',
      async () => {
        let raster: SixelRaster | null
        try {
          raster = await this.owner.encoderLane.encode({
            png: this.source.png,
            cellWidthPx: occurrence.geometry.cellWidthPx,
            cellHeightPx: occurrence.geometry.cellHeightPx,
            maxColumns: occurrence.maxColumns,
            maxRows: occurrence.maxRows,
            cropTopRows,
            maxVisibleRows: visibleRows,
            backgroundRgb: occurrence.geometry.backgroundRgb,
            signal: controller.signal,
          })
        } catch (error) {
          const task = occurrence.pendingCrop
          if (task === undefined || task.controller !== controller) return
          occurrence.pendingCrop = undefined
          const attempts = task.attempts + 1
          occurrence.failedCrop = {
            cropTopRows,
            visibleRows,
            revision: this.owner.registryRevision,
            terminal: attempts >= SIXEL_ENCODE_ATTEMPT_LIMIT,
            kind: 'rejected',
            attempts,
          }
          throw error
        }
        const task = occurrence.pendingCrop
        if (task === undefined || task.controller !== controller) return
        occurrence.pendingCrop = undefined
        if (controller.signal.aborted || this.disposed) return
        if (this.owner.ready?.epoch !== occurrence.geometry.epoch) return
        if (raster === null) {
          occurrence.failedCrop = { cropTopRows, visibleRows, revision: this.owner.registryRevision, terminal: true, kind: 'refused', attempts: 1 }
          return
        }
        const record = this.owner.admitCrop(raster)
        if (record === undefined) {
          occurrence.failedCrop = { cropTopRows, visibleRows, revision: this.owner.registryRevision, terminal: false, kind: 'refused', attempts: 1 }
          return
        }
        occurrence.crop = { cropTopRows, visibleRows, record }
        record.owners.add(occurrence)
        this.owner.requestRepaint()
      },
      { diag: this.owner.diagnosticSink },
    )
  }

  /**
   * Remember one failed attempt for `key` and stop retrying after a bounded number.
   *
   * The first failures are retried (a busy lane clears on its own); once the cap is
   * reached the occurrence stays text until the facts or the trust table change,
   * so a permanent failure can never re-task the lane on every frame.
   */
  private recordFailure(key: string): void {
    const previous = this.failures?.key === key ? this.failures.attempts : 0
    const attempts = previous + 1
    this.failures = { key, attempts }
    if (attempts >= SIXEL_ENCODE_ATTEMPT_LIMIT) {
      this.rejected = { key, revision: this.owner.registryRevision, terminal: true }
    }
  }
}

/** Whether an existing occurrence was encoded for exactly these facts. */
function sameOccurrence(
  occurrence: Occurrence,
  source: SourceBinding,
  geometry: VerifiedGeometry,
  maxColumns: number,
  maxRows: number,
  width: number,
): boolean {
  return (
    occurrence.source.identity === source.identity &&
    occurrence.geometry.cellWidthPx === geometry.cellWidthPx &&
    occurrence.geometry.cellHeightPx === geometry.cellHeightPx &&
    occurrence.geometry.backgroundRgb === geometry.backgroundRgb &&
    occurrence.geometry.epoch === geometry.epoch &&
    occurrence.maxColumns === maxColumns &&
    occurrence.maxRows === maxRows &&
    occurrence.width === width
  )
}
