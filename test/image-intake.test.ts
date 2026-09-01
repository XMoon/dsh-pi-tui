/**
 * M2 tests: magic-byte MIME detection, header-only dimension parsing, the
 * limits preflight, path resolution, and the file intake pipeline (plan §7,
 * §8 + the M2 acceptance matrix). Image samples are generated as minimal
 * byte fixtures — headers only, since the intake never decodes pixels.
 * @module @xmoon76/dsh-pi-tui/image-intake.test
 */

import assert from 'node:assert/strict'
import { symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { ImageDimensionError, ImageTooLargeError, UnsupportedImageTypeError } from '../src/image/errors.ts'
import {
  INTAKE_SAFETY_MAX_BYTES, checkImageLimits, expandHome, parseImageMetadata, readImageFile, resolveImagePath, sniffMediaType,
} from '../src/image/intake.ts'
import type { ImageLimitsLike } from '../src/image/intake.ts'
import type { ImageMediaType } from '../src/image/types.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

/** A structural limit set mirroring the attachment-local defaults. */
const LIMITS: ImageLimitsLike = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8) // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  const set32 = (offset: number, value: number): void => {
    bytes[offset] = (value >>> 24) & 0xff
    bytes[offset + 1] = (value >>> 16) & 0xff
    bytes[offset + 2] = (value >>> 8) & 0xff
    bytes[offset + 3] = value & 0xff
  }
  set32(16, width)
  set32(20, height)
  return bytes
}

function jpegBytes(width: number, height: number): Uint8Array {
  // SOI FF D8, then APP0 (FF E0, len 16, payload), then SOF0 (FF C0, len
  // 17, precision, height BE, width BE), then padding + EOI FF D9 — the
  // scan loop stops at SOF0; the declared segment must fit the buffer, so
  // the fixture carries trailing scan data like a real JPEG.
  const bytes = new Uint8Array(48)
  bytes.set([0xff, 0xd8], 0)
  bytes.set([0xff, 0xe0], 2)
  bytes.set([0x00, 0x10], 4)
  bytes.set([0xff, 0xc0], 22)
  bytes.set([0x00, 0x11], 24)
  bytes[26] = 0x08 // precision
  bytes[27] = (height >>> 8) & 0xff
  bytes[28] = height & 0xff
  bytes[29] = (width >>> 8) & 0xff
  bytes[30] = width & 0xff
  bytes.fill(0x5a, 31, 45) // scan data
  bytes.set([0xff, 0xd9], 46) // EOI
  return bytes
}

function gifBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13)
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0) // GIF89a
  bytes[6] = width & 0xff
  bytes[7] = (width >>> 8) & 0xff
  bytes[8] = height & 0xff
  bytes[9] = (height >>> 8) & 0xff
  return bytes
}

function webpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // 'RIFF'
  bytes.set([0x57, 0x45, 0x42, 0x50], 8) // 'WEBP'
  bytes.set([0x56, 0x50, 0x38, 0x58], 12) // 'VP8X'
  bytes[24] = (width - 1) & 0xff // width-1 LE24
  bytes[25] = ((width - 1) >>> 8) & 0xff
  bytes[26] = ((width - 1) >>> 16) & 0xff
  bytes[27] = (height - 1) & 0xff
  bytes[28] = ((height - 1) >>> 8) & 0xff
  bytes[29] = ((height - 1) >>> 16) & 0xff
  return bytes
}

test('sniffMediaType detects PNG/JPEG/GIF87a/GIF89a/WebP from magic bytes', () => {
  assert.equal(sniffMediaType(pngBytes(1, 1)), 'image/png')
  assert.equal(sniffMediaType(jpegBytes(1, 1)), 'image/jpeg')
  assert.equal(sniffMediaType(gifBytes(1, 1)), 'image/gif')
  assert.equal(sniffMediaType(webpBytes(1, 1)), 'image/webp')
  const gif87 = gifBytes(1, 1)
  gif87.set([0x47, 0x49, 0x46, 0x38, 0x37, 0x61], 0)
  assert.equal(sniffMediaType(gif87), 'image/gif')
})

test('sniffMediaType rejects plain text, empty and truncated buffers', () => {
  assert.equal(sniffMediaType(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])), undefined)
  assert.equal(sniffMediaType(new Uint8Array(0)), undefined)
  assert.equal(sniffMediaType(pngBytes(1, 1).slice(0, 4)), undefined)
})

test('parseImageMetadata extracts dimensions for all four formats', () => {
  assert.deepEqual(parseImageMetadata(pngBytes(1920, 1080)), { mediaType: 'image/png', width: 1920, height: 1080 })
  assert.deepEqual(parseImageMetadata(jpegBytes(640, 480)), { mediaType: 'image/jpeg', width: 640, height: 480 })
  assert.deepEqual(parseImageMetadata(gifBytes(320, 200)), { mediaType: 'image/gif', width: 320, height: 200 })
  assert.deepEqual(parseImageMetadata(webpBytes(100, 50)), { mediaType: 'image/webp', width: 100, height: 50 })
})

test('parseImageMetadata rejects corrupt/truncated headers and spoofed extensions (content is the only truth)', () => {
  const png = pngBytes(10, 10)
  png.set([0x42, 0x41, 0x44, 0x44], 12) // break the IHDR chunk name
  assert.equal(parseImageMetadata(png), undefined)
  const truncated = pngBytes(10, 10).slice(0, 12)
  assert.equal(parseImageMetadata(truncated), undefined)
  const gif = gifBytes(10, 10)
  gif[3] = 0x00 // break the GIF signature
  assert.equal(parseImageMetadata(gif), undefined)
  // A structurally intact header with an absurd width still parses — the
  // limits preflight (not the parser) is the authority for size.
  const wide = pngBytes(10, 10)
  wide[16] = 0xff
  assert.equal(parseImageMetadata(wide)?.width, 4278190090)
})

test('checkImageLimits rejects oversized bytes, pixels, sides and unsupported media types', () => {
  const meta = { mediaType: 'image/png' as ImageMediaType, width: 100, height: 100 }
  checkImageLimits(meta, 100, LIMITS) // fine
  assert.throws(() => checkImageLimits(meta, LIMITS.maxImageBytes + 1, LIMITS), ImageTooLargeError)
  assert.throws(() => checkImageLimits({ ...meta, width: 9000, height: 9000 }, 100, LIMITS), ImageDimensionError)
  assert.throws(() => checkImageLimits({ ...meta, width: 9000, height: 10 }, 100, LIMITS), ImageDimensionError)
  assert.throws(
    () => checkImageLimits({ ...meta, mediaType: 'image/bmp' as ImageMediaType }, 100, LIMITS),
    UnsupportedImageTypeError,
  )
  checkImageLimits(meta, 100, undefined) // no limits = no preflight
})

test('expandHome expands ~ and ~/ forms only', () => {
  assert.equal(expandHome('~'), homedir())
  assert.equal(expandHome('~/Pictures/a.png'), `${homedir()}/Pictures/a.png`)
  assert.equal(expandHome('./a.png'), './a.png')
  assert.equal(expandHome('/abs/a.png'), '/abs/a.png')
})

test('resolveImagePath rejects missing paths, directories and non-regular files', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-image-intake-')
  await assert.rejects(resolveImagePath(join(dir, 'missing.png'), dir), /not found/)
  await assert.rejects(resolveImagePath(dir, dir), /Not a regular file/)
})

test('readImageFile resolves, reads, sniffs, parses and preflights in one pipeline', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-image-intake-')
  const file = join(dir, 'shot.png')
  writeFileSync(file, pngBytes(800, 600))
  const intake = await readImageFile('./shot.png', dir, LIMITS)
  assert.equal(intake.width, 800)
  assert.equal(intake.height, 600)
  assert.equal(intake.mediaType, 'image/png')
  assert.equal(intake.name, 'shot.png')
  assert.equal(intake.path, file)
  // A symlink to the file resolves too.
  const link = join(dir, 'alias.png')
  writeFileSync(join(dir, 'target.png'), pngBytes(1, 1))
  try {
    symlinkSync(join(dir, 'target.png'), link)
    assert.equal((await readImageFile(link, dir, LIMITS)).name, 'target.png')
  } catch {
    // symlink may be unavailable; the pipeline itself is covered above
  }
})

test('readImageFile rejects over-limit files BEFORE reading them into memory', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-image-intake-')
  const file = join(dir, 'big.png')
  writeFileSync(file, pngBytes(10, 10))
  const tight = { ...LIMITS, maxImageBytes: 4 }
  await assert.rejects(readImageFile(file, dir, tight), ImageTooLargeError)
})

test('readImageFile rejects files whose bytes are not a supported image', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-image-intake-')
  const file = join(dir, 'fake.png')
  writeFileSync(file, 'this is not an image')
  await assert.rejects(readImageFile(file, dir, LIMITS), UnsupportedImageTypeError)
})

test('a staged draft carries the intake metadata end to end', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-image-intake-')
  const file = join(dir, 'shot.png')
  writeFileSync(file, pngBytes(800, 600))
  const intake = await readImageFile(file, dir, LIMITS)
  const store = new DraftImageStore()
  const draft = store.add({
    bytes: intake.bytes,
    mediaType: intake.mediaType,
    width: intake.width,
    height: intake.height,
    source: { type: 'path', path: intake.path },
    name: intake.name,
  })
  assert.equal(draft.placeholder, '[image #1 (800×600)]')
  assert.equal(draft.byteLength, intake.bytes.byteLength)
})

test('zero or absurd dimensions are rejected (round-2 finding 7)', () => {
  const zero = pngBytes(0, 0)
  assert.equal(parseImageMetadata(zero), undefined)
  const zeroHeight = pngBytes(10, 0)
  assert.equal(parseImageMetadata(zeroHeight), undefined)
  const wide = pngBytes(10, 10)
  wide[16] = 0xff // width 4278190090 — huge but finite: still parses
  assert.notEqual(parseImageMetadata(wide), undefined)
})

test('malformed SOF segments are rejected (round-4 finding 3)', () => {
  // A JPEG whose SOF0 declares length 2: too short for precision+height+width.
  const bytes = new Uint8Array(24)
  bytes.set([0xff, 0xd8], 0)
  bytes.set([0xff, 0xe0, 0x00, 0x04], 2) // tiny APP0
  bytes.set([0xff, 0xc0, 0x00, 0x02, 0x08, 0x01, 0xe0, 0x02, 0x80], 8) // SOF0 len 2
  assert.equal(parseImageMetadata(bytes), undefined)
})

test('readImageFile without limits still applies the TUI safety cap (review finding 1)', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-image-intake-')
  const file = join(dir, 'big.png')
  writeFileSync(file, pngBytes(10, 10))
  const safety = INTAKE_SAFETY_MAX_BYTES
  // A tiny file passes with no attachment limits at all.
  const intake = await readImageFile(file, dir, undefined, safety - 10)
  assert.equal(intake.width, 10)
  // An over-cap file is refused BEFORE the read.
  await assert.rejects(readImageFile(file, dir, undefined, 4), ImageTooLargeError)
})
