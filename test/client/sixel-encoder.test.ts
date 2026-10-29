/**
 * Image-8 / I8-1C — the ONE SIXEL codec's pixel contract.
 *
 * Every assertion about pixels is made against an INDEPENDENT decoder
 * (`test/support/sixel-oracle.ts`), never against `sixel@0.16.0`'s own decoder:
 * a library that agreed with itself would still be wrong on screen. The oracle
 * also fails on any paint outside the declared raster, which is the overdraw
 * the implementation plan forbids.
 *
 * These cases cover F3 (PNG → RGBA → codec → DCS) and F4 (RGBA-domain top
 * crop). Worker lifecycle, abort and queue bounds live in
 * `test/client/sixel-worker-lifecycle.test.ts`.
 * @module @xmoon76/dsh-pi-tui/client/sixel-encoder.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SixelEncodeRejectedError,
  SixelEncoder,
} from '../../src/client/media/sixel/encode.ts'
import type { SixelRasterRequest } from '../../src/client/media/sixel/types.ts'
import { decodeSixel, pixelAt } from '../support/sixel-oracle.ts'

const CELL_WIDTH_PX = 10
const CELL_HEIGHT_PX = 20

/** Build a real PNG fixture from raw RGBA. */
async function pngFromRgba(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const { default: sharp } = await import('sharp')
  const buffer = await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).png().toBuffer()
  return new Uint8Array(buffer)
}

/** A filled RGBA rectangle, usable as a cheap fixture builder. */
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

function request(overrides: Partial<SixelRasterRequest> & Pick<SixelRasterRequest, 'png'>): SixelRasterRequest {
  return {
    cellWidthPx: CELL_WIDTH_PX,
    cellHeightPx: CELL_HEIGHT_PX,
    maxColumns: 8,
    maxRows: 4,
    cropTopRows: 0,
    backgroundRgb: 0x282c34,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function near(actual: number, expected: number, tolerance = 24): boolean {
  return Math.abs(actual - expected) <= tolerance
}

test('encodes a two-color raster the terminal can actually paint', async () => {
  const encoder = new SixelEncoder()
  try {
    const png = await pngFromRgba(
      fill(40, 40, (x) => (x < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])),
      40,
      40,
    )
    const raster = await encoder.encode(request({ png }))
    assert.notEqual(raster, null)
    const decoded = decodeSixel(raster!.sequence)

    assert.equal(decoded.width, raster!.widthPx)
    assert.equal(decoded.height, raster!.heightPx)
    assert.equal(decoded.height % 6, 0, 'a raster must be a whole number of 6 px bands')
    assert.deepEqual(decoded.paintedBounds, {
      left: 0,
      top: 0,
      right: decoded.width - 1,
      bottom: decoded.height - 1,
    }, 'the painted area must match the declared raster, not spill past it')

    // Left half red, right half blue, read from the oracle rather than the codec.
    const [leftR, leftG, leftB] = pixelAt(decoded, 2, 2)
    assert.ok(near(leftR, 255) && leftG < 40 && leftB < 40, `left half should be red, got ${leftR},${leftG},${leftB}`)
    const [rightR, rightG, rightB] = pixelAt(decoded, decoded.width - 3, 2)
    assert.ok(near(rightB, 255) && rightR < 40 && rightG < 40, `right half should be blue, got ${rightR},${rightG},${rightB}`)

    // Footprint metadata is the real reserved height, not a library claim.
    assert.equal(raster!.rows, Math.ceil(raster!.heightPx / CELL_HEIGHT_PX))
    assert.equal(raster!.footprintRows, raster!.rows)
    assert.equal(raster!.columns, Math.ceil(raster!.widthPx / CELL_WIDTH_PX))
    assert.ok(raster!.columns <= 8 && raster!.rows <= 4)
  } finally {
    await encoder.dispose()
  }
})

test('keeps a real gradient distinguishable end to end', async () => {
  const encoder = new SixelEncoder()
  try {
    const png = await pngFromRgba(
      fill(60, 24, (x) => {
        const value = Math.round((x / 59) * 255)
        return [value, 255 - value, 128, 255]
      }),
      60,
      24,
    )
    const raster = await encoder.encode(request({ png }))
    const decoded = decodeSixel(raster!.sequence)
    const [startR, , startB] = pixelAt(decoded, 0, 0)
    const [endR, , endB] = pixelAt(decoded, decoded.width - 1, 0)
    assert.ok(startR < 60, `gradient start should be dark red, got ${startR}`)
    assert.ok(endR > 195, `gradient end should be bright red, got ${endR}`)
    assert.ok(near(startB, 128) && near(endB, 128), 'the constant channel must survive quantization')
  } finally {
    await encoder.dispose()
  }
})

test('leaves fully transparent pixels unpainted', async () => {
  const encoder = new SixelEncoder()
  try {
    // Checkerboard: transparent cells must stay untouched so the terminal's own
    // background shows through (`backgroundSelect = 1`).
    const png = await pngFromRgba(
      fill(24, 24, (x, y) => (Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0 ? [255, 0, 0, 255] : [0, 255, 0, 0]),
      24,
      24,
    )
    const raster = await encoder.encode(request({ png }))
    const decoded = decodeSixel(raster!.sequence)

    const [opaqueR, opaqueG, , opaqueA] = pixelAt(decoded, 2, 2)
    assert.equal(opaqueA, 255)
    assert.ok(near(opaqueR, 255) && opaqueG < 40, 'opaque cells keep their color')

    const transparentOffset = (2 * decoded.width + decoded.width - 2) * 4
    assert.equal(decoded.rgba[transparentOffset + 3], 0, 'a fully transparent cell must never be painted')
  } finally {
    await encoder.dispose()
  }
})

test('composites semi-transparent pixels over the caller background without bleeding', async () => {
  const encoder = new SixelEncoder()
  try {
    // Opaque blue next to fully transparent RED: if the resize ignored alpha,
    // red would bleed into the blue edge.
    const png = await pngFromRgba(
      fill(40, 40, (x) => (x < 20 ? [0, 0, 255, 255] : [255, 0, 0, 0])),
      40,
      40,
    )
    const raster = await encoder.encode(request({ png }))
    const decoded = decodeSixel(raster!.sequence)
    const [edgeR, edgeG, edgeB] = pixelAt(decoded, 19, 10)
    assert.ok(edgeB > 200, `the opaque edge must stay blue, got ${edgeR},${edgeG},${edgeB}`)
    assert.ok(edgeR < 60, `transparent red must not bleed into the opaque edge, got r=${edgeR}`)
  } finally {
    await encoder.dispose()
  }
})

test('rejects input that is not a PNG', async () => {
  const encoder = new SixelEncoder()
  try {
    const notPng = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    await assert.rejects(() => encoder.encode(request({ png: notPng })), SixelEncodeRejectedError)
  } finally {
    await encoder.dispose()
  }
})

test('rejects an oversized PNG payload before decoding it', async () => {
  const encoder = new SixelEncoder()
  try {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const oversized = new Uint8Array(20 * 1024 * 1024 + 1)
    oversized.set(signature, 0)
    await assert.rejects(() => encoder.encode(request({ png: oversized })), SixelEncodeRejectedError)
  } finally {
    await encoder.dispose()
  }
})

test('refuses to invent the terminal geometry', async () => {
  const encoder = new SixelEncoder()
  try {
    const png = await pngFromRgba(fill(20, 20, () => [255, 0, 0, 255]), 20, 20)
    // A 5 px cell cannot hold one 6 px band; 0 is not a geometry at all.
    await assert.rejects(() => encoder.encode(request({ png, cellHeightPx: 5 })), SixelEncodeRejectedError)
    await assert.rejects(() => encoder.encode(request({ png, cellWidthPx: 0 })), SixelEncodeRejectedError)
    await assert.rejects(() => encoder.encode(request({ png, maxRows: 0 })), SixelEncodeRejectedError)
    await assert.rejects(() => encoder.encode(request({ png, backgroundRgb: 0x1_00_00_00 })), SixelEncodeRejectedError)
  } finally {
    await encoder.dispose()
  }
})

test('returns null when the crop leaves no visible band', async () => {
  const encoder = new SixelEncoder()
  try {
    const png = await pngFromRgba(fill(40, 40, () => [255, 0, 0, 255]), 40, 40)
    const raster = await encoder.encode(request({ png, cropTopRows: 5 }))
    assert.equal(raster, null, 'a fully cropped raster must not emit an empty DCS')
  } finally {
    await encoder.dispose()
  }
})

test('cropTopRows drops whole terminal rows from the SCALED raster', async () => {
  const encoder = new SixelEncoder()
  try {
    // Three 20 px bands: red, green, blue.
    const png = await pngFromRgba(
      fill(40, 60, (_x, y) => (y < 20 ? [255, 0, 0, 255] : y < 40 ? [0, 255, 0, 255] : [0, 0, 255, 255])),
      40,
      60,
    )

    const full = decodeSixel((await encoder.encode(request({ png })))!.sequence)
    const [fullR, fullG] = pixelAt(full, 4, 0)
    assert.ok(near(fullR, 255) && fullG < 40, 'the uncropped top band is red')

    const cropped = decodeSixel((await encoder.encode(request({ png, cropTopRows: 1 })))!.sequence)
    const [cropR, cropG] = pixelAt(cropped, 4, 0)
    assert.ok(cropG > 200 && cropR < 60, `after cropping one row the top band must be green, got ${cropR},${cropG}`)
    assert.equal(cropped.height, 36, 'the remaining 40 px must be floored to whole 6 px bands')

    const twice = decodeSixel((await encoder.encode(request({ png, cropTopRows: 2 })))!.sequence)
    const [twiceR, twiceG, twiceB] = pixelAt(twice, 4, 0)
    assert.ok(twiceB > 200 && twiceR < 60 && twiceG < 60, `after cropping two rows the top band must be blue`)
  } finally {
    await encoder.dispose()
  }
})

test('floors every height to whole bands', async () => {
  const encoder = new SixelEncoder()
  try {
    for (const [sourceHeight, expected] of [[20, 18], [22, 18], [24, 24], [6, 6]] as const) {
      const png = await pngFromRgba(fill(20, sourceHeight, () => [200, 100, 50, 255]), 20, sourceHeight)
      const raster = await encoder.encode(request({ png }))
      assert.equal(raster!.heightPx, expected, `source height ${sourceHeight} must encode to ${expected} px`)
      assert.equal(decodeSixel(raster!.sequence).height, expected)
    }
  } finally {
    await encoder.dispose()
  }
})

test('a single-band source is not stretched past its grant', async () => {
  const encoder = new SixelEncoder()
  try {
    // 3 px tall: only a lift to one band makes it drawable.
    const png = await pngFromRgba(fill(40, 3, () => [0, 200, 100, 255]), 40, 3)
    const raster = await encoder.encode(request({ png, maxColumns: 2, maxRows: 1 }))
    assert.notEqual(raster, null)
    assert.equal(raster!.heightPx, 6)
    assert.ok(raster!.columns <= 2 && raster!.rows <= 1, 'a lifted source must still respect the grant')
  } finally {
    await encoder.dispose()
  }
})

test('never enlarges a source that already fits', async () => {
  const encoder = new SixelEncoder()
  try {
    const png = await pngFromRgba(fill(30, 12, () => [10, 20, 30, 255]), 30, 12)
    const raster = await encoder.encode(request({ png, maxColumns: 20, maxRows: 10 }))
    assert.equal(raster!.widthPx, 30, 'a fitting source must keep its width')
    assert.equal(raster!.heightPx, 12)
  } finally {
    await encoder.dispose()
  }
})

test('caps an oversized source to the codec budget', async () => {
  const encoder = new SixelEncoder()
  try {
    const png = await pngFromRgba(fill(900, 700, () => [90, 90, 200, 255]), 900, 700)
    const raster = await encoder.encode(request({ png, maxColumns: 100, maxRows: 40 }))
    assert.ok(raster!.widthPx <= 800, `width ${raster!.widthPx} must respect the budget`)
    assert.ok(raster!.heightPx <= 600, `height ${raster!.heightPx} must respect the budget`)
    assert.ok(raster!.widthPx * raster!.heightPx <= 400_000, 'area must respect the budget')
  } finally {
    await encoder.dispose()
  }
})

test('refuses work after dispose', async () => {
  const encoder = new SixelEncoder()
  const png = await pngFromRgba(fill(20, 20, () => [255, 255, 255, 255]), 20, 20)
  await encoder.dispose()
  await encoder.dispose()
  await assert.rejects(() => encoder.encode(request({ png })), SixelEncodeRejectedError)
})

test('uses the exact palette when the raster has at most 256 opaque colors', async () => {
  const encoder = new SixelEncoder()
  try {
    // 16x16 with one distinct color per column pair => exactly 16 colors.
    const png = await pngFromRgba(fill(32, 32, (x) => [x * 8, 64, 128, 255]), 32, 32)
    const raster = await encoder.encode(request({ png }))
    const decoded = decodeSixel(raster!.sequence)
    const colors = new Set(raster!.sequence.match(/#\d+;2;[0-9;]+/g) ?? [])
    assert.equal(colors.size, 32, 'every distinct opaque color keeps its own palette slot')
    // A flat two-tone source must never be averaged into one color (the reason
    // `image2sixel` was rejected).
    const [leftR] = pixelAt(decoded, 0, 0)
    const [rightR] = pixelAt(decoded, decoded.width - 1, 0)
    assert.ok(rightR > leftR + 150, `distinct columns must stay distinct, got ${leftR} vs ${rightR}`)
  } finally {
    await encoder.dispose()
  }
})

test('quantizes only when the raster exceeds 256 opaque colors', async () => {
  const encoder = new SixelEncoder()
  try {
    const png = await pngFromRgba(
      fill(64, 48, (x, y) => [(x * 5 + y * 11) % 256, (x * 7 + 40) % 256, (y * 13 + 90) % 256, 255]),
      64,
      48,
    )
    const raster = await encoder.encode(request({ png, maxColumns: 7, maxRows: 3 }))
    const decoded = decodeSixel(raster!.sequence)
    const colors = new Set(raster!.sequence.match(/#\d+;2;[0-9;]+/g) ?? [])
    assert.ok(colors.size > 32, `a photographic source must keep many colors, got ${colors.size}`)
    assert.ok(colors.size <= 256, `the palette budget is 256, got ${colors.size}`)
    // Sampled fidelity against the SOURCE pixels, allowing quantization error.
    let sampled = 0
    let gross = 0
    for (let y = 0; y < decoded.height; y += 4) {
      for (let x = 0; x < decoded.width; x += 4) {
        const scaleX = 64 / decoded.width
        const scaleY = 48 / decoded.height
        const sourceX = Math.min(63, Math.floor(x * scaleX))
        const sourceY = Math.min(47, Math.floor(y * scaleY))
        const [r, g, b] = pixelAt(decoded, x, y)
        sampled += 1
        const expected = [(sourceX * 5 + sourceY * 11) % 256, (sourceX * 7 + 40) % 256, (sourceY * 13 + 90) % 256]
        if (Math.abs(r - expected[0]!) + Math.abs(g - expected[1]!) + Math.abs(b - expected[2]!) > 150) gross += 1
      }
    }
    assert.ok(gross / sampled < 0.15, `gross color errors must stay rare, got ${gross}/${sampled}`)
  } finally {
    await encoder.dispose()
  }
})

test('a real downscale keeps transparent red out of the opaque edge', async () => {
  const encoder = new SixelEncoder()
  try {
    // 80x80 source forced to 40x40 by the grant: this is a REAL resize, unlike
    // the 1:1 case. Right half is fully transparent RED next to opaque BLUE, so
    // an alpha-unaware resize would tint the blue edge red.
    const png = await pngFromRgba(
      fill(80, 80, (x) => (x < 40 ? [0, 0, 255, 255] : [255, 0, 0, 0])),
      80,
      80,
    )
    const raster = await encoder.encode(request({ png, maxColumns: 4, maxRows: 2 }))
    assert.equal(raster!.widthPx, 40, 'the grant must force a downscale')
    assert.equal(raster!.heightPx, 36)

    const decoded = decodeSixel(raster!.sequence)
    const [edgeR, edgeG, edgeB] = pixelAt(decoded, 19, 10)
    assert.ok(edgeB > 200, `the opaque edge must stay blue, got ${edgeR},${edgeG},${edgeB}`)
    assert.ok(edgeR < 70, `transparent red must not bleed into the opaque edge, got r=${edgeR}`)

    const [leftR, leftG, leftB] = pixelAt(decoded, 2, 10)
    assert.ok(leftB > 200 && leftR < 40, 'the opaque interior must stay pure blue')
  } finally {
    await encoder.dispose()
  }
})

test('semi-transparent pixels are composited over the caller background', async () => {
  const encoder = new SixelEncoder()
  const backgroundRgb = 0x282c34
  try {
    // Top rows: alpha 128 red. Bottom rows: fully transparent red (unpainted).
    const png = await pngFromRgba(
      fill(40, 40, (_x, y) => (y < 10 ? [255, 0, 0, 128] : [255, 0, 0, 0])),
      40,
      40,
    )
    const raster = await encoder.encode(request({ png, backgroundRgb }))
    const decoded = decodeSixel(raster!.sequence)

    // 128/255 of pure red over 0x282c34 = (40, 44, 52) per the frozen alpha policy.
    const weight = 128 / 255
    const expected = [
      Math.round(255 * weight + 0x28 * (1 - weight)),
      Math.round(0 * weight + 0x2c * (1 - weight)),
      Math.round(0 * weight + 0x34 * (1 - weight)),
    ]
    const [r, g, b] = pixelAt(decoded, 10, 2)
    // The SIXEL palette is expressed in 0..100 %, so a couple of levels of
    // rounding are expected; a missing composite would be off by ~100.
    assert.ok(near(r, expected[0]!, 4), `red channel ${r} should be ~${expected[0]}`)
    assert.ok(near(g, expected[1]!, 4), `green channel ${g} should be ~${expected[1]}`)
    assert.ok(near(b, expected[2]!, 4), `blue channel ${b} should be ~${expected[2]}`)

    // The fully transparent rows must stay unpainted.
    const transparentOffset = ((decoded.height - 3) * decoded.width + 10) * 4
    assert.equal(decoded.rgba[transparentOffset + 3], 0, 'fully transparent rows must not be painted')
  } finally {
    await encoder.dispose()
  }
})
