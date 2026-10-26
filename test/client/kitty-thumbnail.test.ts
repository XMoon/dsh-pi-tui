/**
 * Image-6A decoder tests: the REAL `sharp` adapter turns committed JPEG/WebP
 * fixtures into bounded PNG derivatives (EXIF orientation, first animation
 * frame, alpha, corruption and pixel ceilings).
 *
 * These tests intentionally use the production `convertKittyThumbnail` and the
 * actual native `sharp`/libvips install — no mock PNG may stand in for the
 * positive path. Fixture provenance and hashes live in
 * `test/fixtures/images/README.md`.
 * @module @xmoon76/dsh-pi-tui/kitty-thumbnail.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import sharp from 'sharp'
import {
  MAX_KITTY_THUMBNAIL_OUTPUT_BYTES,
  convertKittyThumbnail,
} from '../../src/client/media/image/kitty-thumbnail.ts'

const FIXTURES = new URL('../fixtures/images/', import.meta.url)

function fixture(name: string): Buffer {
  return readFileSync(new URL(name, FIXTURES))
}

/** Decode a derived PNG back into raw pixels for the colour/orientation checks. */
async function rawPixels(pngBase64: string): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(Buffer.from(pngBase64, 'base64')).raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

function pixel(data: Buffer, width: number, channels: number, x: number, y: number): number[] {
  const offset = (y * width + x) * channels
  return [...data.subarray(offset, offset + channels)]
}

test('a real JPEG becomes a bounded PNG with its real dimensions', async () => {
  const png = await convertKittyThumbnail(fixture('transcript-sample.jpg'), 'image/jpeg')
  const bytes = Buffer.from(png.base64, 'base64')
  assert.equal(png.byteLength, bytes.length, 'byteLength is the raw PNG size')
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature')
  const metadata = await sharp(bytes).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(png.width, 120)
  assert.equal(png.height, 80)
  assert.ok(png.byteLength > 0 && png.byteLength <= MAX_KITTY_THUMBNAIL_OUTPUT_BYTES)
})

test('a real static WebP becomes a PNG (no animation metadata)', async () => {
  const png = await convertKittyThumbnail(fixture('transcript-sample.webp'), 'image/webp')
  const bytes = Buffer.from(png.base64, 'base64')
  const metadata = await sharp(bytes).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.pages, undefined, 'the derivative is a single-page PNG')
  assert.deepEqual([png.width, png.height], [120, 80])
})

test('a multi-frame WebP derives only its FIRST frame', async () => {
  const source = await sharp(fixture('transcript-animated.webp'), { animated: true }).metadata()
  assert.equal(source.pages, 2, 'the fixture really has two frames')
  const png = await convertKittyThumbnail(fixture('transcript-animated.webp'), 'image/webp')
  const pixels = await rawPixels(png.base64)
  // Frame 1 is solid red; frame 2 is solid blue. A derivative that carried the
  // second frame (or an animation loop) would not be red.
  const [red, green, blue] = pixel(pixels.data, pixels.width, pixels.channels, 32, 20)
  assert.ok(red! >= 250 && green! <= 5 && blue! <= 5, `first frame is red, got ${red},${green},${blue}`)
  const outputMetadata = await sharp(Buffer.from(png.base64, 'base64')).metadata()
  assert.equal(outputMetadata.pages, undefined, 'first page only, never an animation')
  assert.equal(outputMetadata.delay, undefined)
})

test('a transparent WebP keeps its alpha channel', async () => {
  const png = await convertKittyThumbnail(fixture('transcript-alpha.webp'), 'image/webp')
  const pixels = await rawPixels(png.base64)
  assert.equal(pixels.channels, 4, 'alpha survives the derivative')
  assert.equal(pixel(pixels.data, pixels.width, pixels.channels, 5, 10)[3], 0, 'left half is transparent')
  assert.equal(pixel(pixels.data, pixels.width, pixels.channels, 40, 10)[3], 255, 'right half is opaque')
})

test('EXIF orientation is applied to the pixels AND the derived dimensions', async () => {
  const png = await convertKittyThumbnail(fixture('transcript-oriented.jpg'), 'image/jpeg')
  // Stored 60×30 with orientation 6: the DISPLAYED image is 30×60.
  assert.deepEqual([png.width, png.height], [30, 60], 'derived dimensions are the oriented ones')
  const pixels = await rawPixels(png.base64)
  const top = pixel(pixels.data, pixels.width, pixels.channels, 15, 5)
  const bottom = pixel(pixels.data, pixels.width, pixels.channels, 15, 55)
  // Left red / right blue rotated 90° clockwise becomes top red / bottom blue.
  assert.ok(top[0]! > 200 && top[2]! < 30, `rotated top is red, got ${top}`)
  assert.ok(bottom[2]! > 200 && bottom[0]! < 30, `rotated bottom is blue, got ${bottom}`)
})

test('a corrupt JPEG is rejected by the real decoder', async () => {
  await assert.rejects(
    convertKittyThumbnail(fixture('transcript-corrupt.jpg'), 'image/jpeg'),
    /corrupt|premature|Invalid|JPEG/i,
  )
})

test('a corrupt WebP is rejected by the real decoder', async () => {
  await assert.rejects(
    convertKittyThumbnail(fixture('transcript-corrupt.webp'), 'image/webp'),
    /corrupt|unable|WEBP/i,
  )
})

test('an input above the 25 MP decode ceiling is rejected before conversion', async () => {
  const source = await sharp(fixture('transcript-over-limit.jpg')).metadata()
  assert.equal(source.width! * source.height!, 25_005_000, 'fixture exceeds 25_000_000 pixels')
  await assert.rejects(
    convertKittyThumbnail(fixture('transcript-over-limit.jpg'), 'image/jpeg'),
    /pixel limit/i,
  )
})

test('small sources are never enlarged (withoutEnlargement)', async () => {
  const png = await convertKittyThumbnail(fixture('transcript-alpha.webp'), 'image/webp')
  assert.deepEqual([png.width, png.height], [48, 32], 'the 48×32 source keeps its size')
})
