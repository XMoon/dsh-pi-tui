/**
 * Image intake: file → validated draft bytes (plan M2, §7-§8).
 *
 * The intake is split into PURE functions (magic-byte sniffing, lightweight
 * header-only dimension parsing, limits preflight) and one IO function
 * (`readImageFile`: resolve → stat → read → sniff → parse → preflight).
 * The pure half is fully unit-testable without a filesystem; the IO half
 * stays narrow so the /image command handler and the headless tests can
 * drive it with real files.
 *
 * Design rules from the plan:
 * - extension is NEVER the MIME authority (magic bytes only, §7.2);
 * - stat BEFORE readFile so an over-limit file never enters memory (§7.3);
 * - only regular files are accepted (symlinks resolve to their target,
 *   §7.1);
 * - the harness's `ctx.attachments.imageLimits` is the ONLY limit source —
 *   nothing here hardcodes a deployment default (§21);
 * - metadata parsing is header-only; no image decoder is imported (§8).
 * @module @xmoon76/dsh-pi-tui/image/intake
 */

import { realpathSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'
import { ImageDimensionError, ImageInputError, ImageTooLargeError, UnsupportedImageTypeError } from './errors.ts'
import type { ImageMediaType } from './types.ts'

/** The deployment image policy, structural subset of
 * `ctx.attachments.imageLimits` (AGENTS.md decision 7). */
export interface ImageLimitsLike {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly maxImagePixels: number
  readonly maxImageDimension: number
  readonly mediaTypes: readonly ImageMediaType[]
}

/** Sniffed + parsed raster facts for one byte buffer. */
export interface ImageMetadata {
  readonly mediaType: ImageMediaType
  readonly width: number
  readonly height: number
}

/** The fully-resolved outcome of reading one image file. */
export interface ImageFileIntake {
  readonly bytes: Uint8Array
  readonly mediaType: ImageMediaType
  readonly width: number
  readonly height: number
  /** Display name (basename), never a path. */
  readonly name: string
  /** Canonical resolved path (realpath), for diagnostics. */
  readonly path: string
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]

/** True when `bytes` starts with every byte of `signature`. */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false
  }
  return true
}

/** Detect the raster media type from magic bytes only. */
export function sniffMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg'
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!)
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
    const webp = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
  }
  return undefined
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
}

/** PNG: IHDR at offset 8; width/height are big-endian u32 at 16/20. */
function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined
  const chunkType = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
  if (chunkType !== 'IHDR') return undefined
  return { width: readUInt32BE(bytes, 16), height: readUInt32BE(bytes, 20) }
}

/**
 * JPEG dimensions from the SOFn marker scan (SOF0-15, excluding the
 * arithmetic/table markers C4/C8/CC). Height precedes width in the frame
 * header, both big-endian.
 */
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4) return undefined
  let offset = 2
  // `<=` so a SOF segment ending exactly at the buffer end is still read.
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    // Skip fill bytes (FF FF ...) and standalone markers.
    let marker = bytes[offset + 1]!
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    const length = readUInt16BE(bytes, offset + 2)
    if (length < 2) return undefined
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      // A valid SOF payload is precision(1) + height(2) + width(2) +
      // component count(1) + component specs — never shorter than 8 bytes;
      // the declared segment must also fit the buffer (round-4 finding 3).
      if (length < 8 || offset + 2 + length > bytes.length) return undefined
      return {
        height: readUInt16BE(bytes, offset + 5),
        width: readUInt16BE(bytes, offset + 7),
      }
    }
    offset += 2 + length
  }
  return undefined
}

/** GIF logical screen descriptor: little-endian width/height at 6/8. */
function gifDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 10) return undefined
  return { width: readUInt16LE(bytes, 6), height: readUInt16LE(bytes, 8) }
}

/** WebP dimensions for the VP8 (lossy) / VP8L (lossless) / VP8X (extended)
 * chunk variants (the same offsets the vendored pi-tui fork parses). */
function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
  if (chunk === 'VP8 ') {
    return {
      width: readUInt16LE(bytes, 26) & 0x3fff,
      height: readUInt16LE(bytes, 28) & 0x3fff,
    }
  }
  if (chunk === 'VP8L') {
    if (bytes.length < 25) return undefined
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    }
  }
  if (chunk === 'VP8X') {
    return {
      width: (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1,
      height: (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1,
    }
  }
  return undefined
}

/**
 * Parse raster metadata from raw bytes: magic-byte MIME detection plus
 * header-only dimension parsing. Returns undefined for non-images,
 * truncated/corrupt headers, or impossible dimensions (<= 0 or non-finite
 * — round-2 finding 7; the harness re-validates at admission).
 */
export function parseImageMetadata(bytes: Uint8Array): ImageMetadata | undefined {
  const mediaType = sniffMediaType(bytes)
  if (mediaType === undefined) return undefined
  const parsed = mediaType === 'image/png'
    ? pngDimensions(bytes)
    : mediaType === 'image/jpeg'
      ? jpegDimensions(bytes)
      : mediaType === 'image/gif'
        ? gifDimensions(bytes)
        : webpDimensions(bytes)
  if (parsed === undefined) return undefined
  if (!(parsed.width > 0) || !(parsed.height > 0)
    || !Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) {
    return undefined
  }
  return { mediaType, width: parsed.width, height: parsed.height }
}

/**
 * Preflight one parsed image against the deployment's attachment limits.
 * Throws the actionable intake errors; the harness re-checks at admission.
 * @param meta - sniffed metadata.
 * @param byteLength - exact encoded byte length.
 * @param limits - the deployment image policy (or undefined = no preflight).
 */
export function checkImageLimits(
  meta: ImageMetadata,
  byteLength: number,
  limits: ImageLimitsLike | undefined,
): void {
  if (limits === undefined) return
  if (!limits.mediaTypes.includes(meta.mediaType)) {
    throw new UnsupportedImageTypeError(`The deployment does not accept ${meta.mediaType}.`)
  }
  if (byteLength > limits.maxImageBytes) {
    throw new ImageTooLargeError(byteLength, limits.maxImageBytes)
  }
  if (meta.width * meta.height > limits.maxImagePixels) {
    throw new ImageDimensionError(
      `Image is ${meta.width}×${meta.height} (${meta.width * meta.height} px); the pixel limit is ${limits.maxImagePixels} px.`,
    )
  }
  if (meta.width > limits.maxImageDimension || meta.height > limits.maxImageDimension) {
    throw new ImageDimensionError(
      `Image is ${meta.width}×${meta.height}; the dimension limit is ${limits.maxImageDimension} px per side.`,
    )
  }
}

/** Expand a leading `~` to the home directory (no other shell expansion). */
export function expandHome(raw: string): string {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return `${homedir()}${raw.slice(1)}`
  return raw
}

/**
 * Resolve one path argument to a canonical regular-file path.
 * @param raw - the raw argument (already shell-word parsed).
 * @param cwd - the TUI working directory for relative paths.
 * @returns the canonical real path.
 * @throws ImageInputError when the target is missing, unreadable, or not a
 *   regular file (directory/FIFO/socket/device are rejected, §7.1). Error
 *   messages name the BASENAME only — full private paths are never logged
 *   (§21).
 */
export function resolveImagePath(raw: string, cwd: string): string {
  const expanded = expandHome(raw)
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
  const label = basename(absolute)
  let real: string
  try {
    real = realpathSync(absolute)
  } catch (error) {
    throw new ImageInputError(`Image file not found: ${label}`)
  }
  let stats
  try {
    stats = statSync(real)
  } catch (error) {
    throw new ImageInputError(`Image file cannot be read: ${label}`)
  }
  if (!stats.isFile()) {
    throw new ImageInputError(`Not a regular file: ${label}`)
  }
  return real
}

/**
 * Read one image file end to end: resolve → stat → size preflight → read →
 * sniff → parse → dimension preflight. Throws the actionable errors from
 * errors.ts; the caller stages the result into the draft store.
 * @param rawPath - the command argument (shell-word parsed already).
 * @param cwd - the working directory for relative paths.
 * @param limits - the deployment image policy (undefined = skip preflight).
 */
export function readImageFile(rawPath: string, cwd: string, limits: ImageLimitsLike | undefined): ImageFileIntake {
  const path = resolveImagePath(rawPath, cwd)
  const stats = statSync(path)
  if (limits !== undefined && stats.size > limits.maxImageBytes) {
    throw new ImageTooLargeError(stats.size, limits.maxImageBytes)
  }
  const bytes = new Uint8Array(readFileSync(path))
  const meta = parseImageMetadata(bytes)
  if (meta === undefined) {
    throw new UnsupportedImageTypeError()
  }
  checkImageLimits(meta, bytes.byteLength, limits)
  return {
    bytes,
    mediaType: meta.mediaType,
    width: meta.width,
    height: meta.height,
    name: basename(path),
    path,
  }
}
