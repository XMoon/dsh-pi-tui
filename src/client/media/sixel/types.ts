/**
 * Image-8 / I8-1C — fixed data contracts and safety bounds for the ONE SIXEL
 * codec.
 *
 * Everything here is an explicit bound, not a tunable: a caller may never ask
 * the encoder for an unbounded decode, an unbounded raster, or an unbounded
 * number of concurrent jobs. The values mirror the implementation plan so a
 * future consumer (`I8-2A`) inherits them instead of re-deriving its own.
 * @module @xmoon76/dsh-pi-tui/client/media/sixel/types
 */

/** Smallest accepted trusted PNG payload. */
export const SIXEL_MIN_PNG_BYTES = 1
/** Largest accepted trusted PNG payload (rejected before any decode). */
export const SIXEL_MAX_PNG_BYTES = 20 * 1024 * 1024
/** Largest accepted source dimension per axis. */
export const SIXEL_MAX_SOURCE_DIMENSION = 8192
/** Largest accepted source pixel count. */
export const SIXEL_MAX_SOURCE_PIXELS = 16_000_000
/** Largest encoded raster width in device pixels. */
export const SIXEL_MAX_TARGET_WIDTH_PX = 800
/** Largest encoded raster height in device pixels. */
export const SIXEL_MAX_TARGET_HEIGHT_PX = 600
/** Largest encoded raster area in device pixels. */
export const SIXEL_MAX_TARGET_AREA_PX = 400_000
/** Largest accepted cell width in device pixels. */
export const SIXEL_MAX_CELL_WIDTH_PX = 128
/** Largest accepted cell height in device pixels (a SIXEL band is 6 px). */
export const SIXEL_MAX_CELL_HEIGHT_PX = 128
/** A SIXEL band is always 6 device pixels high. */
export const SIXEL_BAND_HEIGHT_PX = 6
/** Largest accepted encoded DCS payload. */
export const SIXEL_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/** Largest number of QUEUED jobs next to the one active job. */
export const SIXEL_MAX_QUEUED_JOBS = 16
/**
 * Deadline for the WORKER encode stage only: one `sixelEncode()` call plus its
 * round trip. A timeout is a real failure, never an empty success.
 *
 * It deliberately does NOT bound the whole request. The plan freezes a worker
 * timeout and nothing else, and sharp's native decode/resize/quantize work
 * cannot be interrupted at an arbitrary point, so a whole-job deadline would
 * either abandon work that keeps holding the lane or require a second
 * isolation mechanism this stage does not have. What bounds the earlier stages
 * is the input budget instead: {@link SIXEL_MAX_PNG_BYTES},
 * {@link SIXEL_MAX_SOURCE_DIMENSION}, {@link SIXEL_MAX_SOURCE_PIXELS} and the
 * target caps are all checked before or around the decode, so the
 * preprocessing cost is bounded by the accepted input, not by a wall clock.
 *
 * A future consumer that wants an end-to-end deadline must settle the request
 * and await the in-flight native work before releasing the lane; racing a
 * promise at the call site would let two jobs overlap.
 */
export const SIXEL_WORKER_ENCODE_TIMEOUT_MS = 5000
/** Palette ceiling handed to the codec. */
export const SIXEL_PALETTE_MAX_COLORS = 256
/** SIXEL background select `1`: never repaint untouched zero-bit positions. */
export const SIXEL_BACKGROUND_SELECT = 1

/**
 * One encode request.
 *
 * `png` must already be an authorized, trusted PNG — this API never accepts
 * SIXEL text from an external source and never re-encodes untrusted terminal
 * bytes. Geometry and background are REQUIRED: the encoder refuses to invent a
 * `9x18` cell or a guessed background color.
 */
export interface SixelRasterRequest {
  /** Trusted PNG bytes. */
  readonly png: Uint8Array
  /** Verified cell width in device pixels (from a real `CSI 16t` reply). */
  readonly cellWidthPx: number
  /** Verified cell height in device pixels; must fit at least one band. */
  readonly cellHeightPx: number
  /** Columns the current layout grants. */
  readonly maxColumns: number
  /** Rows the current layout grants. */
  readonly maxRows: number
  /** Whole terminal rows hidden above the visible window. */
  readonly cropTopRows: number
  /** Real terminal background as `0xRRGGBB`, used for semi-transparent pixels. */
  readonly backgroundRgb: number
  /** Cancellation owned by the caller. */
  readonly signal: AbortSignal
}

/**
 * One encoded raster.
 *
 * `rows` is the real reserved height derived from the encoded band height and
 * the cell height — never the raster size the library claims. A Screen must
 * clear `footprintRows` rows, because clearing the anchor row alone leaves
 * pixels behind.
 */
export interface SixelRaster {
  /** Exactly one complete DCS produced by the codec. */
  readonly sequence: string
  /** Columns actually reserved. */
  readonly columns: number
  /** Rows actually reserved. */
  readonly rows: number
  /** Encoded raster width in device pixels. */
  readonly widthPx: number
  /** Encoded raster height in device pixels (a whole number of 6 px bands). */
  readonly heightPx: number
  /** Rows a Screen must erase; equal to `rows`. */
  readonly footprintRows: number
}
