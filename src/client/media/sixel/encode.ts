/**
 * Image-8 / I8-1C — the ONE Client-local SIXEL codec.
 *
 * Pipeline (frozen by the implementation plan):
 *
 *   trusted PNG bytes → bounded metadata check → `sharp` async decode/resize
 *   → RGBA-domain top crop → alpha compositing over the caller's real
 *   background → worker `image2sixel` → validated DCS
 *
 * Three properties are load-bearing:
 *
 * 1. **No unbounded work.** Every dimension, byte count, pixel count and queue
 *    length is bounded BEFORE the expensive step, so a rejected request costs
 *    a header read, not a decode.
 * 2. **No render-stack CPU.** `sharp` runs off the render path and quantization
 *    runs in a `worker_threads` worker; `I8-2A`'s consumer only awaits a
 *    promise.
 * 3. **No invented geometry.** The cell size and the background color are
 *    required inputs from their real authorities. A `9x18` default or a guessed
 *    black background would silently mis-scale a raster, so neither exists.
 *
 * This module deliberately knows nothing about Screen lines, transcripts or
 * protocols: it turns one authorized PNG into one DCS plus its real footprint.
 * @module @xmoon76/dsh-pi-tui/client/media/sixel/encode
 */

import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import {
  SIXEL_BACKGROUND_SELECT,
  SIXEL_BAND_HEIGHT_PX,
  SIXEL_WORKER_ENCODE_TIMEOUT_MS,
  SIXEL_MAX_CELL_HEIGHT_PX,
  SIXEL_MAX_CELL_WIDTH_PX,
  SIXEL_MAX_OUTPUT_BYTES,
  SIXEL_MAX_PNG_BYTES,
  SIXEL_MAX_QUEUED_JOBS,
  SIXEL_MAX_SOURCE_DIMENSION,
  SIXEL_MAX_SOURCE_PIXELS,
  SIXEL_MAX_TARGET_AREA_PX,
  SIXEL_MAX_TARGET_HEIGHT_PX,
  SIXEL_MAX_TARGET_WIDTH_PX,
  SIXEL_MIN_PNG_BYTES,
  SIXEL_PALETTE_MAX_COLORS,
  type SixelRaster,
  type SixelRasterRequest,
} from './types.ts'
import { SIXEL_WORKER_SOURCE } from './worker-source.ts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The request is outside the frozen bounds, or the terminal has no geometry. */
export class SixelEncodeRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SixelEncodeRejectedError'
  }
}

/** More encode work is queued than one lane may hold; the caller must fall back. */
export class SixelEncodeBusyError extends Error {
  constructor(queued: number) {
    super(`SIXEL encoder already has ${queued} queued jobs (limit ${SIXEL_MAX_QUEUED_JOBS}).`)
    this.name = 'SixelEncodeBusyError'
  }
}

/** The encode worker failed, timed out, or returned a payload outside the contract. */
export class SixelEncodeFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SixelEncodeFailedError'
  }
}

/** Absolute path of the pinned CJS codec, resolved from the shipped module. */
let codecModulePath: string | undefined
function resolveCodecModulePath(): string {
  if (codecModulePath === undefined) {
    codecModulePath = createRequire(import.meta.url).resolve('sixel')
  }
  return codecModulePath
}

interface Plan {
  readonly widthPx: number
  /** Full scaled height BEFORE the top crop; this is the resize target. */
  readonly scaledHeightPx: number
  /** Drawable height after the crop, floored to whole 6 px bands. */
  readonly heightPx: number
  readonly columns: number
  readonly rows: number
  /** Whole rows hidden above the visible window, in the SCALED pixel space. */
  readonly hiddenPx: number
}

/** A planned box plus the exact RGBA that will be quantized. */
interface Prepared {
  readonly plan: Plan
  readonly rgba: Uint8Array
}

/** An RGB triple in the order the codec's palette expects. */
type PaletteEntry = [number, number, number]

/** A planned box, the exact RGBA to encode, and that raster's exact palette. */
interface Palettized {
  readonly plan: Plan
  readonly rgba: Uint8Array
  readonly palette: PaletteEntry[]
}

function positiveInteger(value: number, label: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new SixelEncodeRejectedError(`${label} must be an integer in 1..${max}; received ${String(value)}.`)
  }
  return value
}

/**
 * Validate the request's static bounds. Runs before any decode, so an
 * oversized or geometry-less request never allocates pixels.
 */
function checkRequest(request: SixelRasterRequest): void {
  const { png } = request
  if (png.length < SIXEL_MIN_PNG_BYTES || png.length > SIXEL_MAX_PNG_BYTES) {
    throw new SixelEncodeRejectedError(
      `PNG payload must be ${SIXEL_MIN_PNG_BYTES}..${SIXEL_MAX_PNG_BYTES} bytes; received ${png.length}.`,
    )
  }
  if (png.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.equals(Buffer.from(png.subarray(0, PNG_SIGNATURE.length)))) {
    throw new SixelEncodeRejectedError('SIXEL encoding only accepts trusted PNG input.')
  }
  positiveInteger(request.cellWidthPx, 'cellWidthPx', SIXEL_MAX_CELL_WIDTH_PX)
  positiveInteger(request.cellHeightPx, 'cellHeightPx', SIXEL_MAX_CELL_HEIGHT_PX)
  if (request.cellHeightPx < SIXEL_BAND_HEIGHT_PX) {
    throw new SixelEncodeRejectedError(
      `cellHeightPx must fit one ${SIXEL_BAND_HEIGHT_PX} px SIXEL band; received ${String(request.cellHeightPx)}.`,
    )
  }
  positiveInteger(request.maxColumns, 'maxColumns', Number.MAX_SAFE_INTEGER)
  positiveInteger(request.maxRows, 'maxRows', Number.MAX_SAFE_INTEGER)
  if (request.maxVisibleRows !== undefined) {
    positiveInteger(request.maxVisibleRows, 'maxVisibleRows', request.maxRows)
  }
  if (!Number.isInteger(request.cropTopRows) || request.cropTopRows < 0) {
    throw new SixelEncodeRejectedError(`cropTopRows must be a non-negative integer; received ${String(request.cropTopRows)}.`)
  }
  if (!Number.isInteger(request.backgroundRgb) || request.backgroundRgb < 0 || request.backgroundRgb > 0xffffff) {
    throw new SixelEncodeRejectedError(`backgroundRgb must be 0x000000..0xFFFFFF; received ${String(request.backgroundRgb)}.`)
  }
  if (request.signal.aborted) {
    throw new SixelEncodeRejectedError('The encode request was already aborted.')
  }
}

/**
 * Choose the encoded cell box, or `null` when nothing drawable fits.
 *
 * The raster is never enlarged beyond the source (a tiny source is lifted to
 * one 6 px band only, because a sub-band raster cannot be drawn at all), and
 * the result never exceeds the caller's column/row grant or the codec budget.
 */
function planRaster(request: SixelRasterRequest, sourceWidth: number, sourceHeight: number): Plan | null {
  const { cellWidthPx, cellHeightPx, maxColumns, maxRows, cropTopRows } = request
  const grantWidthPx = maxColumns * cellWidthPx
  const grantHeightPx = maxRows * cellHeightPx
  if (grantHeightPx < SIXEL_BAND_HEIGHT_PX) return null

  const scale = Math.min(1, grantWidthPx / sourceWidth, grantHeightPx / sourceHeight)
  let widthPx = Math.max(1, Math.floor(sourceWidth * scale))
  let heightPx = Math.max(1, Math.floor(sourceHeight * scale))

  // A raster shorter than one band cannot paint anything, so a small source is
  // lifted to exactly one band. This is the only enlargement the codec allows.
  if (heightPx < SIXEL_BAND_HEIGHT_PX) {
    const lift = SIXEL_BAND_HEIGHT_PX / heightPx
    heightPx = SIXEL_BAND_HEIGHT_PX
    widthPx = Math.min(Math.round(sourceWidth * lift), grantWidthPx, SIXEL_MAX_TARGET_WIDTH_PX)
  }

  // Hard codec budget, applied proportionally so the aspect ratio is preserved.
  const budget = Math.min(
    1,
    SIXEL_MAX_TARGET_WIDTH_PX / widthPx,
    SIXEL_MAX_TARGET_HEIGHT_PX / heightPx,
    Math.sqrt(SIXEL_MAX_TARGET_AREA_PX / (widthPx * heightPx)),
  )
  widthPx = Math.max(1, Math.floor(widthPx * budget))
  heightPx = Math.max(1, Math.floor(heightPx * budget))

  const hiddenPx = cropTopRows * cellHeightPx
  // `maxRows` drove the scale above; the visible-window ceiling only ends the
  // raster EARLY, so a bottom-truncated variant has the same pixels-per-cell as
  // the full one and the same top-crop arithmetic still lands on whole rows.
  const visibleRows = request.maxVisibleRows ?? maxRows
  const visibleAvailable = Math.min(heightPx - hiddenPx, visibleRows * cellHeightPx)
  const drawableHeightPx = Math.floor(visibleAvailable / SIXEL_BAND_HEIGHT_PX) * SIXEL_BAND_HEIGHT_PX
  if (drawableHeightPx <= 0) return null

  const columns = Math.ceil(widthPx / cellWidthPx)
  const rows = Math.ceil(drawableHeightPx / cellHeightPx)
  if (columns > maxColumns || rows > maxRows) return null
  return { widthPx, scaledHeightPx: heightPx, heightPx: drawableHeightPx, columns, rows, hiddenPx }
}

/**
 * Composite semi-transparent pixels over the caller's real background.
 *
 * Fully transparent pixels keep `alpha = 0`: the codec respects exactly that
 * value, and the `backgroundSelect = 1` introducer leaves those positions
 * untouched, so the terminal's own background shows through. Opaque pixels are
 * passed through unchanged.
 */
function compositeAlpha(rgba: Uint8Array, backgroundRgb: number): void {
  const background = [(backgroundRgb >> 16) & 0xff, (backgroundRgb >> 8) & 0xff, backgroundRgb & 0xff]
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = rgba[index + 3]!
    if (alpha === 0 || alpha === 255) continue
    const weight = alpha / 255
    for (let channel = 0; channel < 3; channel += 1) {
      const source = rgba[index + channel]!
      rgba[index + channel] = Math.round(source * weight + background[channel]! * (1 - weight))
    }
    rgba[index + 3] = 255
  }
}

/**
 * Distinct opaque colors of the raster in scan order.
 *
 * `overflow` means "more than the palette budget", not "failed": the caller
 * then quantizes once with sharp and derives the palette from the quantized
 * pixels. An empty palette with no overflow means a fully transparent raster,
 * which paints nothing and must not emit a DCS.
 */
function collectExactPalette(rgba: Uint8Array): { palette: PaletteEntry[]; overflow: boolean } {
  const seen = new Set<number>()
  const palette: PaletteEntry[] = []
  for (let index = 0; index < rgba.length; index += 4) {
    // A fully transparent pixel is never painted, so it must not consume a slot.
    if (rgba[index + 3] === 0) continue
    const key = (rgba[index]! << 16) | (rgba[index + 1]! << 8) | rgba[index + 2]!
    if (seen.has(key)) continue
    if (palette.length === SIXEL_PALETTE_MAX_COLORS) return { palette, overflow: true }
    seen.add(key)
    palette.push([(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff])
  }
  return { palette, overflow: false }
}

/**
 * Quantize an over-budget raster to the palette budget through sharp's indexed
 * PNG path, then read the RESULT back as RGBA.
 *
 * The palette is derived from the decoded pixels rather than from sharp's own
 * report, so every color handed to the codec is exactly a color that will be
 * painted: the codec paints exact palette matches and leaves anything else
 * untouched.
 */
async function quantizeIndexed(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const { default: sharp } = await import('sharp')
  const indexed = await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
    .png({ palette: true, colours: SIXEL_PALETTE_MAX_COLORS, dither: 1.0, effort: 4 })
    .toBuffer()
  const { data } = await sharp(indexed, { failOn: 'error', animated: false, pages: 1 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (data.length !== width * height * 4) {
    throw new SixelEncodeFailedError('sharp returned a quantized buffer out of step with the planned box.')
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
}

/**
 * Validate the codec's output against the contract instead of trusting it.
 *
 * The declared raster attributes must match the pixels actually handed to the
 * codec, and the DCS must be a single well-terminated sequence: a library that
 * emitted two payloads or a stray finalizer would otherwise paint past the
 * rows the caller reserved.
 */
function checkSequence(sequence: string, plan: Plan): void {
  if (typeof sequence !== 'string' || sequence.length === 0) {
    throw new SixelEncodeFailedError('SIXEL codec returned an empty payload.')
  }
  if (Buffer.byteLength(sequence, 'utf8') > SIXEL_MAX_OUTPUT_BYTES) {
    throw new SixelEncodeFailedError(`SIXEL payload exceeds ${SIXEL_MAX_OUTPUT_BYTES} bytes.`)
  }
  if (!sequence.startsWith('\x1bP') || !sequence.endsWith('\x1b\\')) {
    throw new SixelEncodeFailedError('SIXEL payload is not one complete DCS.')
  }
  // Exactly one terminator, and it is the last two characters.
  if (sequence.indexOf('\x1b\\') !== sequence.length - 2) {
    throw new SixelEncodeFailedError('SIXEL payload contains more than one DCS terminator.')
  }
  const introducer = /^\x1bP[0-9;]*q/.exec(sequence)
  if (introducer === null) {
    throw new SixelEncodeFailedError('SIXEL payload has no `q` introducer.')
  }
  const raster = /^"([0-9]+);([0-9]+);([0-9]+);([0-9]+)/.exec(sequence.slice(introducer[0].length))
  if (raster === null) {
    throw new SixelEncodeFailedError('SIXEL payload has no raster attributes.')
  }
  const declaredWidth = Number.parseInt(raster[3]!, 10)
  const declaredHeight = Number.parseInt(raster[4]!, 10)
  if (declaredWidth !== plan.widthPx || declaredHeight !== plan.heightPx) {
    throw new SixelEncodeFailedError(
      `SIXEL payload declares ${declaredWidth}x${declaredHeight} but the codec was given ${plan.widthPx}x${plan.heightPx}.`,
    )
  }
}

/** One encode job as the lane sees it. */
interface Job {
  readonly request: SixelRasterRequest
  readonly resolve: (raster: SixelRaster | null) => void
  readonly reject: (error: unknown) => void
  settled: boolean
  aborted: boolean
  worker: Worker | undefined
  /** Shared promise so every caller waits for the SAME real termination. */
  termination: Promise<void> | undefined
  timer: NodeJS.Timeout | undefined
  readonly onAbort: () => void
}

/**
 * The ONE Client-local SIXEL encode lane.
 *
 * A single encoder owns at most one active worker and at most
 * {@link SIXEL_MAX_QUEUED_JOBS} waiting jobs. Callers share one instance; a
 * component that spawns its own worker would break both the memory bound and
 * the "no encode inside the render stack" rule.
 */
export class SixelEncoder {
  private readonly queue: Job[] = []
  private active: Job | undefined
  private disposed = false
  /** The single in-flight disposal, shared by every caller. */
  private disposal: Promise<void> | undefined

  /**
   * Encode one authorized PNG.
   *
   * Resolves `null` when nothing drawable fits the grant, rejects with
   * {@link SixelEncodeRejectedError} for an out-of-contract request,
   * {@link SixelEncodeBusyError} when the lane is full, and
   * {@link SixelEncodeFailedError} when the codec fails. A rejection never
   * represents a successful empty image.
   */
  async encode(request: SixelRasterRequest): Promise<SixelRaster | null> {
    if (this.disposed) throw new SixelEncodeRejectedError('The SIXEL encoder was disposed.')
    checkRequest(request)
    if (this.queue.length >= SIXEL_MAX_QUEUED_JOBS) throw new SixelEncodeBusyError(this.queue.length)

    return new Promise<SixelRaster | null>((resolve, reject) => {
      const job: Job = {
        request,
        resolve,
        reject,
        settled: false,
        aborted: false,
        worker: undefined,
        termination: undefined,
        timer: undefined,
        onAbort: () => {
          job.aborted = true
          const aborted = (): SixelEncodeRejectedError => new SixelEncodeRejectedError('The encode request was aborted.')
          const index = this.queue.indexOf(job)
          if (index >= 0) {
            this.queue.splice(index, 1)
            this.#settle(job, undefined, aborted())
            return
          }
          // The active job owns the worker: settle immediately so the caller's
          // promise never hangs, then terminate so the lane can advance without
          // waiting for the codec to finish a result nobody will use.
          if (this.active === job) {
            this.#settle(job, undefined, aborted())
            void this.#terminateWorker(job)
          }
        },
      }
      request.signal.addEventListener('abort', job.onAbort, { once: true })
      this.queue.push(job)
      void this.#pump()
    })
  }

  /**
   * Cancel every pending job, terminate the worker, and refuse new work.
   *
   * Every caller awaits the SAME disposal: a second `dispose()` during an
   * in-flight termination must not resolve early, or "the worker is gone" would
   * be a guess rather than an observation.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    for (const job of [...this.queue]) {
      this.queue.splice(this.queue.indexOf(job), 1)
      this.#settle(job, undefined, new SixelEncodeRejectedError('The SIXEL encoder was disposed.'))
    }
    const active = this.active
    this.disposal = (async (): Promise<void> => {
      if (active === undefined) return
      active.aborted = true
      // Settle first: a worker exit must not race in and decide the caller's
      // error. `#settle` is idempotent, so the later teardown cannot re-settle.
      this.#settle(active, undefined, new SixelEncodeRejectedError('The SIXEL encoder was disposed.'))
      await this.#terminateWorker(active)
    })()
    return this.disposal
  }

  #pump(): void {
    if (this.disposed || this.active !== undefined) return
    const job = this.queue.shift()
    if (job === undefined) return
    this.active = job
    void this.#run(job).finally(() => {
      this.active = undefined
      this.#pump()
    })
  }

  async #run(job: Job): Promise<void> {
    try {
      if (job.aborted) {
        this.#settleAborted(job)
        return
      }
      const prepared = await this.#prepare(job)
      if (job.aborted) {
        this.#settleAborted(job)
        return
      }
      if (prepared === null) {
        this.#settle(job, null)
        return
      }
      const palettized = await this.#palettize(prepared)
      if (job.aborted) {
        this.#settleAborted(job)
        return
      }
      if (palettized === null) {
        this.#settle(job, null)
        return
      }
      const raster = await this.#quantize(job, palettized)
      if (job.aborted) {
        this.#settleAborted(job)
        return
      }
      this.#settle(job, raster)
    } catch (error) {
      // `#settle` is idempotent, so a cancellation that already settled the job
      // is not overwritten by whatever the terminated worker reports.
      this.#settle(job, undefined, error)
    } finally {
      await this.#terminateWorker(job)
    }
  }

  /** Settle a cancelled job without ever resolving it as a usable raster. */
  #settleAborted(job: Job): void {
    this.#settle(job, undefined, new SixelEncodeRejectedError('The encode request was aborted.'))
  }

  /**
   * Decode, resize and crop. The lane is already held here, so at most one
   * decode is resident and the queue cannot multiply memory.
   */
  async #prepare(job: Job): Promise<Prepared | null> {
    const { png } = job.request
    const { default: sharp } = await import('sharp')
    const metadata = await sharp(Buffer.from(png), { failOn: 'error', animated: false, pages: 1 }).metadata()
    const sourceWidth = metadata.width ?? 0
    const sourceHeight = metadata.height ?? 0
    if (
      sourceWidth < 1 ||
      sourceHeight < 1 ||
      sourceWidth > SIXEL_MAX_SOURCE_DIMENSION ||
      sourceHeight > SIXEL_MAX_SOURCE_DIMENSION ||
      sourceWidth * sourceHeight > SIXEL_MAX_SOURCE_PIXELS
    ) {
      throw new SixelEncodeRejectedError(`PNG source ${sourceWidth}x${sourceHeight} is outside the decode budget.`)
    }
    const plan = planRaster(job.request, sourceWidth, sourceHeight)
    if (plan === null) return null

    // Resize FIRST, crop second: cropping the source would change the scale the
    // caller asked for. libvips premultiplies an alpha channel for the resize
    // and unpremultiplies afterwards, so transparent neighbors cannot bleed.
    const { data } = await sharp(Buffer.from(png), { failOn: 'error', animated: false, pages: 1 })
      .resize(plan.widthPx, plan.scaledHeightPx, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (data.length !== plan.widthPx * plan.scaledHeightPx * 4) {
      throw new SixelEncodeFailedError('sharp returned an RGBA buffer out of step with the planned box.')
    }

    const rowBytes = plan.widthPx * 4
    const start = plan.hiddenPx * rowBytes
    const visibleBytes = plan.heightPx * rowBytes
    if (plan.hiddenPx + plan.heightPx > plan.scaledHeightPx) {
      throw new SixelEncodeFailedError('the crop window falls outside the scaled raster.')
    }
    const visible = new Uint8Array(data.buffer, data.byteOffset + start, visibleBytes).slice()
    compositeAlpha(visible, job.request.backgroundRgb)
    job.request.signal.throwIfAborted()
    return { plan, rgba: visible }
  }

  /**
   * Derive the exact palette for the prepared pixels.
   *
   * Up to {@link SIXEL_PALETTE_MAX_COLORS} opaque colors are used verbatim, so
   * flat art, charts and two-tone images cannot be re-quantized; an
   * over-budget raster is quantized once by sharp and its decoded colors become
   * the palette. Runs inside the held lane, so quantization never runs
   * concurrently with another job.
   */
  async #palettize(prepared: Prepared): Promise<Palettized | null> {
    const exact = collectExactPalette(prepared.rgba)
    if (!exact.overflow) {
      if (exact.palette.length === 0) return null
      return { plan: prepared.plan, rgba: prepared.rgba, palette: exact.palette }
    }
    const quantized = await quantizeIndexed(prepared.rgba, prepared.plan.widthPx, prepared.plan.heightPx)
    const derived = collectExactPalette(quantized)
    if (derived.palette.length === 0) return null
    if (derived.overflow) {
      // sharp's indexed output is bounded by `colours`; a larger result means
      // the round trip did not do what the contract requires.
      throw new SixelEncodeFailedError('sharp indexed quantization exceeded the palette budget.')
    }
    return { plan: prepared.plan, rgba: quantized, palette: derived.palette }
  }

  /** Hand the bounded RGBA and its exact palette to the worker, then validate. */
  async #quantize(job: Job, palettized: Palettized): Promise<SixelRaster> {
    const { plan, rgba, palette } = palettized
    const worker = new Worker(SIXEL_WORKER_SOURCE, {
      eval: true,
      workerData: {
        modulePath: resolveCodecModulePath(),
        rgba,
        width: plan.widthPx,
        height: plan.heightPx,
        palette,
        backgroundSelect: SIXEL_BACKGROUND_SELECT,
      },
      transferList: [rgba.buffer as ArrayBuffer],
    })
    job.worker = worker

    const sequence = await new Promise<string>((resolve, reject) => {
      // Scope: this worker call only. The decode/quantize stages that ran
      // before it are bounded by the input budget, not by this clock.
      job.timer = setTimeout(() => {
        reject(new SixelEncodeFailedError(`SIXEL worker encode exceeded ${SIXEL_WORKER_ENCODE_TIMEOUT_MS} ms.`))
      }, SIXEL_WORKER_ENCODE_TIMEOUT_MS)
      worker.once('message', (message: unknown) => {
        const payload = message as { ok?: unknown; sequence?: unknown; message?: unknown }
        if (payload.ok === true && typeof payload.sequence === 'string') {
          resolve(payload.sequence)
          return
        }
        reject(new SixelEncodeFailedError(`SIXEL worker failed: ${String(payload.message ?? 'unknown error')}`))
      })
      worker.once('error', (error: Error) => {
        reject(new SixelEncodeFailedError(`SIXEL worker crashed: ${error.message}`))
      })
      worker.once('exit', (code) => {
        reject(new SixelEncodeFailedError(`SIXEL worker exited with code ${String(code)} before replying.`))
      })
    })
    if (job.timer !== undefined) {
      clearTimeout(job.timer)
      job.timer = undefined
    }
    checkSequence(sequence, plan)
    return {
      sequence,
      columns: plan.columns,
      rows: plan.rows,
      widthPx: plan.widthPx,
      heightPx: plan.heightPx,
      footprintRows: plan.rows,
    }
  }

  /**
   * Terminate this job's worker, at most once, and let every caller await the
   * SAME real termination.
   *
   * Clearing `job.worker` before the wait would let the abort path start a
   * termination while `#run`'s cleanup returns immediately, so the lane could
   * advance before the old worker had actually exited. The shared promise is
   * what makes "the previous worker is gone" true for the next job.
   */
  #terminateWorker(job: Job): Promise<void> {
    if (job.timer !== undefined) {
      clearTimeout(job.timer)
      job.timer = undefined
    }
    if (job.termination === undefined) {
      const worker = job.worker
      job.worker = undefined
      job.termination = worker === undefined ? Promise.resolve() : worker.terminate().then(() => undefined)
    }
    return job.termination
  }

  #settle(job: Job, raster: SixelRaster | null | undefined, error?: unknown): void {
    if (job.settled) return
    job.settled = true
    job.request.signal.removeEventListener('abort', job.onAbort)
    if (error !== undefined) job.reject(error)
    else job.resolve(raster ?? null)
  }
}
