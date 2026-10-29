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
 * Capacity boundary: the registry retains at most
 * {@link SIXEL_REGISTRY_MAX_VARIANTS} encoded rasters and refuses a new one
 * rather than evicting a record a LIVE occurrence still renders. `owners` is
 * component lifetime, not "painted by the current frame", on purpose: evicting a
 * record while its component still emits that DCS would make the Screen treat a
 * raster as untrusted text, and the plan's two-method port has no channel to
 * invalidate the component. A refusal is therefore TERMINAL for that request: only
 * a change to the request's own facts (source, width, cell box, background, epoch)
 * mints a new key and tries again. The honest consequence is that a transcript with more
 * expanded occurrences than the cap shows the over-budget ones as text, even when
 * they are off screen; releasing off-screen records needs a component-visible
 * invalidation channel and is recorded as a follow-up rather than guessed here.
 *
 * The display derivative is never persisted, transmitted or exported: it is a
 * Client-local projection of bytes the existing `ImageLoader` already
 * authorized.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/sixel-image
 */

import { createHash } from 'node:crypto'
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
 * One occurrence's encoded raster and the facts it was encoded for.
 *
 * `crop` holds at most one CURRENT variant: the one the last frame asked for.
 * A superseded variant is unregistered immediately, so a fast scroll back to a
 * previous offset re-encodes instead of projecting a stale crop.
 */
interface Occurrence {
  readonly source: SourceBinding
  readonly geometry: VerifiedGeometry
  readonly maxColumns: number
  readonly maxRows: number
  readonly width: number
  full: RasterRecord
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

  private cropTrusted(line: string, cropTopRows: number, visibleRows: number): string | undefined {
    const record = this.records.get(line)
    if (record === undefined) return undefined
    record.useStamp = ++this.useStamp
    // Only a FULL raster has a source to re-encode from: cropping a crop variant
    // would derive a window from a window.
    if (record.kind !== 'full') return undefined
    const occurrence = record.owners.values().next().value
    if (occurrence === undefined || this.disposed) return undefined
    const fullRows = occurrence.full.rows
    if (!Number.isInteger(cropTopRows) || cropTopRows < 0 || cropTopRows >= fullRows) return undefined
    if (!Number.isInteger(visibleRows) || visibleRows < 1) return undefined
    const bounded = Math.min(visibleRows, fullRows - cropTopRows)
    if (cropTopRows === 0 && bounded >= fullRows) return occurrence.full.dcs
    const current = occurrence.crop
    if (current !== undefined && current.cropTopRows === cropTopRows && current.visibleRows === bounded) {
      if (this.records.get(current.record.dcs) !== current.record) {
        // The record left the trust table (a shared variant released by its other
        // owner): fail closed instead of returning a string the Screen no longer
        // recognises as an image.
        occurrence.crop = undefined
        return undefined
      }
      current.record.useStamp = ++this.useStamp
      return current.record.dcs
    }
    const pending = occurrence.pendingCrop
    if (pending !== undefined && pending.cropTopRows === cropTopRows && pending.visibleRows === bounded) {
      return undefined
    }
    // A variant that deterministically produced nothing (or was refused by the
    // budget) must not be re-requested on every frame; a changed trust table may
    // make a refused one succeed, so the revision is part of the memory.
    const failed = occurrence.failedCrop
    if (
      failed !== undefined &&
      failed.cropTopRows === cropTopRows &&
      failed.visibleRows === bounded &&
      (failed.terminal || (failed.kind === 'refused' && failed.revision === this.admissionRevision))
    ) {
      return undefined
    }
    // A retry for the SAME window inherits its failure count; a different window
    // starts a fresh budget.
    const carriedAttempts =
      failed !== undefined && failed.cropTopRows === cropTopRows && failed.visibleRows === bounded
        ? failed.attempts
        : 0
    pending?.controller.abort()
    this.releaseCrop(occurrence)
    const controller = new AbortController()
    occurrence.pendingCrop = { cropTopRows, visibleRows: bounded, controller, attempts: carriedAttempts }
    runDetached(
      'SIXEL crop variant',
      async () => {
        let raster: SixelRaster | null
        try {
          raster = await this.encoder.encode({
            png: occurrence.source.png,
            cellWidthPx: occurrence.geometry.cellWidthPx,
            cellHeightPx: occurrence.geometry.cellHeightPx,
            maxColumns: occurrence.maxColumns,
            maxRows: occurrence.maxRows,
            cropTopRows,
            maxVisibleRows: bounded,
            backgroundRgb: occurrence.geometry.backgroundRgb,
            signal: controller.signal,
          })
        } catch (error) {
          // Settle the token even on failure: a rejected crop must not answer
          // `undefined` forever. A busy lane is retried a bounded number of times.
          const task = occurrence.pendingCrop
          // A SUPERSEDED or cancelled task is not this window's failure: never charge
          // its error to the window the user is looking at now.
          if (task === undefined || task.controller !== controller) return
          occurrence.pendingCrop = undefined
          const attempts = task.attempts + 1
          occurrence.failedCrop = {
            cropTopRows,
            visibleRows: bounded,
            revision: this.admissionRevision,
            terminal: attempts >= SIXEL_ENCODE_ATTEMPT_LIMIT,
            kind: 'rejected',
            attempts,
          }
          throw error
        }
        const settled = occurrence.pendingCrop
        if (settled === undefined || settled.controller !== controller) return
        occurrence.pendingCrop = undefined
        if (controller.signal.aborted || this.disposed || !this.occurrences.has(occurrence)) return
        // Nothing drawable (a fully transparent window) or a refused budget: keep
        // the row empty and remember the outcome for THIS window.
        if (raster === null) {
          // A transparent window paints nothing, for these facts, forever.
          occurrence.failedCrop = {
            cropTopRows,
            visibleRows: bounded,
            revision: this.admissionRevision,
            terminal: true,
            kind: 'refused',
            attempts: 1,
          }
          return
        }
        const registered = this.admit(raster, 'crop')
        if (registered === undefined) {
          // A budget refusal may succeed once the trust table changes.
          occurrence.failedCrop = {
            cropTopRows,
            visibleRows: bounded,
            revision: this.admissionRevision,
            terminal: false,
            kind: 'refused',
            attempts: 1,
          }
          return
        }
        registered.owners.add(occurrence)
        occurrence.crop = { cropTopRows, visibleRows: bounded, record: registered }
        this.onReadinessChanged()
      },
      { diag: this.diag },
    )
    return undefined
  }

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

  /**
   * Drop the least recently used CROP variant.
   *
   * A full raster belongs to a live component that is still painting it, and
   * the plan forbids dropping a record that is on screen to make room: when
   * nothing else is evictable the new request falls back to text instead.
   */
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

  private releaseCrop(occurrence: Occurrence): void {
    occurrence.failedCrop = undefined
    const crop = occurrence.crop
    if (crop === undefined) return
    occurrence.crop = undefined
    // Two occurrences can share one crop raster (identical visible pixels). Only
    // the LAST owner may unregister it; the other still paints the same bytes.
    crop.record.owners.delete(occurrence)
    if (crop.record.owners.size === 0) this.unregister(crop.record)
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

  /** @internal — one new occurrence identity. */
  addOccurrence(occurrence: Occurrence): void {
    this.occurrences.add(occurrence)
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
    occurrence.pendingCrop?.controller.abort()
    occurrence.pendingCrop = undefined
    this.releaseCrop(occurrence)
    occurrence.full.owners.delete(occurrence)
    if (occurrence.full.owners.size === 0) this.unregister(occurrence.full)
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
      occurrence.full.owners.delete(occurrence)
    }
    this.occurrences.clear()
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
  private entry: ReadyEntry | undefined
  private inFlight: { key: string; controller: AbortController } | undefined
  /** A request not worth re-sending on every frame; `terminal` means "for these
   *  facts, forever" (a transparent picture or a spent retry budget). */
  private rejected: { key: string; revision: number; terminal: boolean } | undefined
  /** Bounded retries per key: a transient failure may retry, a permanent one may not
   *  spin the single encoder lane forever. */
  private failures: { key: string; attempts: number } | undefined
  private cachedLines: string[] | undefined
  private cachedWidth: number | undefined
  /** The exact encode key the cached frame was produced for. A background/epoch
   *  change at an unchanged width must miss it, or the old composite would be
   *  re-emitted after re-verification. */
  private cachedKey: string | undefined
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
   * The real painted footprint at `width`, or `undefined` when that render
   * carried no pixels.
   *
   * Only a registered, encoded raster answers: a pending encode, a budget
   * fallback and a fully transparent window all paint no body, so a click can
   * never open the Viewer from a row of text.
   */
  paintedBodyAt(width: number): NativeKittyImageBody | undefined {
    const entry = this.entry
    if (entry === undefined || this.cachedWidth !== width) return undefined
    return { width, columns: entry.record.columns, rows: entry.record.rows }
  }

  render(width: number): string[] {
    if (this.disposed) return [this.options.fallback]
    const geometry = this.owner.ready
    if (geometry === undefined) {
      // A fact loss (a denied DA1, a stopped/replaced screen, a timed-out
      // background or a resize) makes the previous pixels illegal on THIS
      // frame, cached or not: the raster is dropped and the row becomes text.
      this.cachedLines = undefined
      this.cachedWidth = undefined
      this.retire()
      return [this.options.fallback]
    }
    const bounds = this.bounds(geometry, width)
    const key = bounds.key
    if (this.cachedLines !== undefined && this.cachedKey === key) return this.cachedLines
    const lines = this.paint(geometry, bounds)
    this.cachedLines = lines
    this.cachedWidth = width
    this.cachedKey = key
    return lines
  }

  /**
   * The cell box this occurrence may use at `width`, plus the EXACT key every
   * raster it produces depends on (source, width, cell box, background, epoch).
   *
   * One derivation feeds both the encoder request and the frame cache, so a stale
   * composite can never be reused and the two can never drift apart.
   */
  private bounds(geometry: VerifiedGeometry, width: number): { width: number; maxColumns: number; maxRows: number; key: string } {
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
    return { width, maxColumns, maxRows, key }
  }

  /** Drop the cached frame but keep the raster: a repaint of the same
   *  occurrence must not re-encode the same picture. */
  invalidate(): void {
    this.cachedLines = undefined
    this.cachedWidth = undefined
    this.cachedKey = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.inFlight?.controller.abort()
    this.inFlight = undefined
    this.rejected = undefined
    this.failures = undefined
    this.entry = undefined
    if (this.occurrence !== undefined) this.owner.removeOccurrence(this.occurrence)
    this.occurrence = undefined
    this.cachedLines = undefined
    this.cachedWidth = undefined
  }

  private paint(
    geometry: VerifiedGeometry,
    bounds: { width: number; maxColumns: number; maxRows: number; key: string },
  ): string[] {
    const { width, maxColumns, maxRows, key } = bounds
    const entry = this.entry
    if (entry !== undefined && entry.key === key) return this.readyLines(entry.record)
    const occurrence = this.occurrence
    if (
      occurrence !== undefined &&
      sameOccurrence(occurrence, this.source, geometry, maxColumns, maxRows, width)
    ) {
      // The facts are unchanged and the raster is still registered: only the
      // per-frame render cache was dropped (an `invalidate()`), so this repaint
      // must NOT start a second encode of the same picture.
      this.entry = { key, record: occurrence.full }
      return this.readyLines(occurrence.full)
    }
    if (this.inFlight?.key === key) return [this.options.fallback]
    const rejected = this.rejected
    if (
      rejected !== undefined &&
      rejected.key === key &&
      (rejected.terminal || rejected.revision === this.owner.registryRevision)
    ) {
      return [this.options.fallback]
    }
    if (this.failures !== undefined && this.failures.key !== key) this.failures = undefined
    this.retire()
    this.startEncode(key, geometry, maxColumns, maxRows, width)
    return [this.options.fallback]
  }

  private readyLines(record: RasterRecord): string[] {
    const lines: string[] = [record.dcs]
    for (let row = 1; row < record.rows; row++) lines.push('')
    return lines
  }

  private startEncode(
    key: string,
    geometry: VerifiedGeometry,
    maxColumns: number,
    maxRows: number,
    width: number,
  ): void {
    this.inFlight?.controller.abort()
    const controller = new AbortController()
    this.inFlight = { key, controller }
    runDetached(
      'SIXEL image encode',
      async () => {
        let raster: SixelRaster | null
        try {
          raster = await this.owner.encoderLane.encode({
            png: this.source.png,
            cellWidthPx: geometry.cellWidthPx,
            cellHeightPx: geometry.cellHeightPx,
            maxColumns,
            maxRows,
            cropTopRows: 0,
            backgroundRgb: geometry.backgroundRgb,
            signal: controller.signal,
          })
        } catch (error) {
          // A rejected request (a full lane, a refusal, a codec failure) must still
          // SETTLE this occurrence's token. Leaving it set would make every later
          // frame believe the encode is still running and paint text forever.
          if (this.inFlight?.controller === controller) this.inFlight = undefined
          this.recordFailure(key)
          // The cached frame holds the fallback under this exact key: leaving it
          // would make every later render return it without ever retrying.
          this.cachedLines = undefined
          this.cachedWidth = undefined
          this.cachedKey = undefined
          throw error
        }
        if (this.disposed || this.inFlight?.controller !== controller) return
        this.inFlight = undefined
        // A superseded request never paints: the key carries every fact the
        // raster was produced for, so a result that settled after a screen,
        // width, cell or background change is dropped here.
        if (controller.signal.aborted) return
        if (raster === null) {
          // A fully transparent picture paints nothing, deterministically.
          this.rejected = { key, revision: this.owner.registryRevision, terminal: true }
          return
        }
        if (this.owner.ready?.epoch !== geometry.epoch) return
        const record = this.owner.admitFull(raster)
        if (record === undefined) {
          // Every retained variant is in use. A refusal is TERMINAL for these facts:
          // evicting a record a live component still renders would make the Screen
          // treat that raster as text, and the port has no component-invalidation
          // channel. Any real change (source, width, cell, background, epoch) mints a
          // new key and tries again; the cached text frame is the intended result.
          this.rejected = { key, revision: this.owner.registryRevision, terminal: true }
          return
        }
        const occurrence: Occurrence = {
          source: this.source,
          geometry,
          maxColumns,
          maxRows,
          width,
          full: record,
        }
        record.owners.add(occurrence)
        this.occurrence = occurrence
        this.entry = { key, record }
        this.owner.addOccurrence(occurrence)
        this.cachedLines = undefined
        this.cachedWidth = undefined
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

  private retire(): void {
    this.inFlight?.controller.abort()
    this.inFlight = undefined
    this.entry = undefined
    if (this.occurrence !== undefined) this.owner.removeOccurrence(this.occurrence)
    this.occurrence = undefined
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
