/**
 * Image-8 / I8-5 — the bounded transparent-first-band normalizer.
 *
 * The production encoder is the only grammar this transform accepts. Every
 * pixel assertion below goes through the independent decoder
 * (`test/support/sixel-oracle.ts`), so a transform that "looks plausible" but
 * changes what the terminal paints cannot pass.
 * @module @xmoon76/dsh-pi-tui/tui/zellij-sixel-width.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SixelEncoder } from '../../src/client/media/sixel/encode.ts'
import type { SixelRaster, SixelRasterRequest } from '../../src/client/media/sixel/types.ts'
import { SIXEL_MAX_OUTPUT_BYTES } from '../../src/client/media/sixel/types.ts'
import { normalizeZellijSixelRaster } from '../../src/tui/graphics/zellij-sixel-width.ts'
import { decodeSixel, pixelAt } from '../support/sixel-oracle.ts'

const CELL_WIDTH_PX = 10
const CELL_HEIGHT_PX = 20

async function pngFromRgba(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const { default: sharp } = await import('sharp')
  const buffer = await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).png().toBuffer()
  return new Uint8Array(buffer)
}

function fill(width: number, height: number, color: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = color(x, y)
      const offset = (y * width + x) * 4
      rgba[offset] = r
      rgba[offset + 1] = g
      rgba[offset + 2] = b
      rgba[offset + 3] = a
    }
  }
  return rgba
}

function request(png: Uint8Array, overrides: Partial<SixelRasterRequest> = {}): SixelRasterRequest {
  return {
    png,
    cellWidthPx: CELL_WIDTH_PX,
    cellHeightPx: CELL_HEIGHT_PX,
    maxColumns: 8,
    maxRows: 6,
    cropTopRows: 0,
    backgroundRgb: 0x282c34,
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function encode(t: test.TestContext, png: Uint8Array, overrides: Partial<SixelRasterRequest> = {}): Promise<SixelRaster> {
  const encoder = new SixelEncoder()
  t.after(() => encoder.dispose())
  const raster = await encoder.encode(request(png, overrides))
  assert.notEqual(raster, null)
  return raster!
}

/** The first band boundary of the production encoder's grammar. */
function firstBandDash(sequence: string): number {
  const introducer = /^\x1bP[0-9;]*q/.exec(sequence)
  assert.ok(introducer)
  const body = sequence.slice(introducer[0].length, -2)
  const raster = /^"[0-9]+;[0-9]+;[0-9]+;[0-9]+/.exec(body)
  assert.ok(raster)
  const dash = body.indexOf('-', raster[0].length)
  assert.ok(dash > 0)
  return introducer[0].length + dash
}

test('a fully transparent first band gets a real transparent width run and keeps every pixel', async (t) => {
  const png = await pngFromRgba(fill(40, 40, (_x, y) => (y < 20 ? [0, 0, 0, 0] : [255, 0, 0, 255])), 40, 40)
  const raster = await encode(t, png)
  const normalized = normalizeZellijSixelRaster(raster)
  assert.ok(normalized)
  assert.notEqual(normalized.sequence, raster.sequence, 'the empty first band is repaired')

  const dash = firstBandDash(normalized.sequence)
  const beforeDash = normalized.sequence.slice(0, dash)
  assert.ok(beforeDash.endsWith(`!${raster.widthPx}?$`), 'the inserted run is exactly the declared pixel width')

  const original = decodeSixel(raster.sequence)
  const repaired = decodeSixel(normalized.sequence)
  assert.equal(repaired.width, raster.widthPx)
  assert.equal(repaired.width, original.width)
  assert.equal(repaired.height, original.height)
  assert.equal(repaired.paintedBounds?.top, original.paintedBounds?.top)
  const firstPaintedRow = repaired.paintedBounds?.top ?? 0
  assert.ok(firstPaintedRow >= 6, 'the transparent first band paints nothing')
  for (let y = 0; y < repaired.height; y += 1) {
    const [r, g, b, a] = pixelAt(repaired, 4, y)
    const [or, og, ob, oa] = pixelAt(original, 4, y)
    assert.deepEqual([r, g, b, a], [or, og, ob, oa], `pixel at y=${y} is unchanged`)
    if (y < firstPaintedRow) assert.equal(a, 0, 'the transparent leading bands stay transparent')
    if (y >= firstPaintedRow) assert.ok(r > 180 && g < 80 && b < 80, `the opaque band is red at y=${y}`)
  }
})

test('an ordinary opaque first band is byte-identical', async (t) => {
  const png = await pngFromRgba(fill(40, 40, () => [255, 0, 0, 255]), 40, 40)
  const raster = await encode(t, png)
  assert.equal(normalizeZellijSixelRaster(raster)?.sequence, raster.sequence)
})

test('full, top-cropped and bottom-cropped variants keep their declared width and footprint', async (t) => {
  const png = await pngFromRgba(fill(40, 40, (_x, y) => (y < 20 ? [0, 0, 0, 0] : [0, 0, 255, 255])), 40, 40)
  const cases = [
    await encode(t, png, {}),
    await encode(t, png, { cropTopRows: 1, maxRows: 6 }),
    await encode(t, png, { cropTopRows: 1, maxVisibleRows: 2 }),
  ]
  for (const raster of cases) {
    const normalized = normalizeZellijSixelRaster(raster)
    assert.ok(normalized)
    const decoded = decodeSixel(normalized.sequence)
    assert.equal(decoded.width, normalized.widthPx, 'the encoded width is the declared width')
    assert.equal(decoded.height, normalized.heightPx, 'the encoded height never grows')
    assert.ok(decoded.height <= normalized.rows * CELL_HEIGHT_PX, 'the raster stays inside its cell footprint')
    assert.ok((decoded.paintedBounds?.right ?? 0) <= normalized.widthPx - 1, 'no pixel paints past the raster width')
  }
})

test('unsupported grammars and width mismatches are refused, never passed through', () => {
  const base = '\x1bP0;1;q"1;1;10;10#0;2;100;0;0'
  const raster = (sequence: string, widthPx = 10): SixelRaster => ({
    sequence,
    columns: 1,
    rows: 1,
    widthPx,
    heightPx: 6,
    footprintRows: 1,
  })
  assert.equal(normalizeZellijSixelRaster(raster(`${base}\u0001-\x1b\\`)), undefined, 'an unexpected token is refused')
  assert.equal(normalizeZellijSixelRaster(raster(`\x1bP0;1;q"1;1;10;10#0;2;100;0;0-\x1b\\\x1b\\`)), undefined,
    'more than one terminator is refused')
  assert.equal(normalizeZellijSixelRaster(raster(`${base}!\x1b\\`)), undefined, 'a malformed repeat is refused')
  assert.equal(normalizeZellijSixelRaster(raster(`${base}-\x1b\\`, 9)), undefined,
    'a declared width that disagrees with the raster is refused')
  const alreadyRepaired = raster('\x1bP0;1;q"1;1;10;10#0;2;100;0;0!10?$-\x1b\\')
  assert.equal(normalizeZellijSixelRaster(alreadyRepaired), alreadyRepaired,
    'an already-present transparent run is never duplicated')
})

test('the input budget refuses a repaired payload that would exceed the codec bound', () => {
  const prefix = '\x1bP0;1;q"1;1;10;10#0;2;100;0;0'
  const raster: SixelRaster = {
    sequence: `${prefix}${'-'.repeat(SIXEL_MAX_OUTPUT_BYTES)}\x1b\\`,
    columns: 1,
    rows: 1,
    widthPx: 10,
    heightPx: 6,
    footprintRows: 1,
  }
  assert.equal(normalizeZellijSixelRaster(raster), undefined)
})
