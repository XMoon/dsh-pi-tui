/**
 * Client-local JPEG/WebP → PNG preview derivation for Kitty transcript
 * thumbnails (Image-6A, §2.2 / §5.1).
 *
 * Kitty's graphics protocol only places PNG payloads, so a JPEG/WebP
 * transcript attachment gets a bounded, EXIF-corrected PNG derivative before
 * the pi-tui `Image` component can paint pixels for it. This module is the ONE
 * native decoder boundary: no UI module imports `sharp`, no render call
 * converts synchronously, and the vendored fork's synchronous transcoder hook
 * stays unused.
 *
 * Resource contract (the loader/thumbnail own the surrounding policy):
 * - the source is capped at {@link MAX_KITTY_THUMBNAIL_SOURCE_BYTES};
 * - `sharp` is constructed with `limitInputPixels: 25_000_000` — never
 *   `unlimited`;
 * - output is fitted inside 768×768 without enlargement, first page only,
 *   EXIF orientation applied;
 * - the PNG buffer must be non-empty and within
 *   {@link MAX_KITTY_THUMBNAIL_OUTPUT_BYTES}.
 *
 * Failures are thrown to the caller (the Client `ImageLoader` records a
 * bounded, sanitized preview failure); nothing here touches the terminal.
 * @module @xmoon76/dsh-pi-tui/client/media/image/kitty-thumbnail
 */

/** Largest original JPEG/WebP whose bytes the preview pipeline will read.
 * Checked cheaply from `ImageAttachmentRefLike.bytes` before the attachment
 * read and again against the real `Uint8Array` length before decoding. */
export const MAX_KITTY_THUMBNAIL_SOURCE_BYTES = 20 * 1024 * 1024

/** Largest derived PNG admitted as a READY preview. */
export const MAX_KITTY_THUMBNAIL_OUTPUT_BYTES = 4 * 1024 * 1024

/** Decode-time pixel ceiling passed to libvips (never `unlimited`). */
const MAX_INPUT_PIXELS = 25_000_000
/** The fitted derivative never exceeds this many pixels per axis. */
const MAX_OUTPUT_DIMENSION = 768
/** libvips processing timeout; native module loading/thread queueing is NOT
 * part of this bound (the preview is asynchronous either way). */
const CONVERSION_TIMEOUT_SECONDS = 5

/** The derived PNG the Kitty thumbnail renders. */
export interface KittyThumbnailPng {
  readonly base64: string
  readonly width: number
  readonly height: number
  /** The raw PNG byte length (before base64 expansion). */
  readonly byteLength: number
}

/** The decoder seam. Only JPEG/WebP may enter this boundary. */
export type KittyThumbnailConverter = (
  input: Uint8Array,
  mediaType: 'image/jpeg' | 'image/webp',
) => Promise<KittyThumbnailPng>

/** A derived PNG exceeded {@link MAX_KITTY_THUMBNAIL_OUTPUT_BYTES}; the
 * loader maps this typed failure to its `output-too-large` preview state
 * instead of misreporting a corrupt source. */
export class KittyThumbnailOutputTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Derived PNG is ${bytes} bytes; the preview budget is ${MAX_KITTY_THUMBNAIL_OUTPUT_BYTES} bytes.`)
    this.name = 'KittyThumbnailOutputTooLargeError'
  }
}

/** Decode one JPEG/WebP and return the bounded PNG derivative. */
export const convertKittyThumbnail: KittyThumbnailConverter = async (input, mediaType) => {
  const { default: sharp } = await import('sharp')
  const { data, info } = await sharp(Buffer.from(input), {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: 'error',
    animated: false,
    pages: 1,
  })
    .autoOrient()
    .resize({
      width: MAX_OUTPUT_DIMENSION,
      height: MAX_OUTPUT_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 6, palette: false })
    .timeout({ seconds: CONVERSION_TIMEOUT_SECONDS })
    .toBuffer({ resolveWithObject: true })
  // The pipeline above fixes the format and the fit; these are its output
  // invariants, not a fallback path. A violated invariant is a decoder bug.
  if (info.format !== 'png') {
    throw new Error(`Kitty thumbnail conversion produced ${String(info.format)} instead of PNG (${mediaType}).`)
  }
  if (info.width <= 0 || info.height <= 0 || info.width > MAX_OUTPUT_DIMENSION || info.height > MAX_OUTPUT_DIMENSION) {
    throw new Error(`Kitty thumbnail conversion produced an out-of-budget ${info.width}×${info.height} PNG.`)
  }
  if (data.length === 0) throw new Error('Kitty thumbnail conversion produced an empty PNG.')
  if (data.length > MAX_KITTY_THUMBNAIL_OUTPUT_BYTES) {
    throw new KittyThumbnailOutputTooLargeError(data.length)
  }
  return {
    base64: data.toString('base64'),
    width: info.width,
    height: info.height,
    byteLength: data.length,
  }
}
