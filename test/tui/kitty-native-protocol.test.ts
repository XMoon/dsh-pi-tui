/**
 * Image-7A PR1 — the Native Kitty wire.
 *
 * The encoder tests are the byte-level half of the qualification: a managed
 * placement may not depend on the fork's private `renderImage`, so the only
 * way to keep the two paths visually identical is to cross-check the real
 * `Image.render()` output at the same width. A geometry drift is exactly the
 * defect that would make a managed image's click band and its painted pixels
 * disagree.
 * @module @xmoon76/dsh-pi-tui/tui/kitty-native-protocol.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Image, setCapabilities } from '@xmoon76/pi-tui'
import {
  KITTY_APC_INTRODUCER,
  KITTY_APC_TERMINATOR,
  KITTY_TRANSMIT_CHUNK_CHARS,
  calculateNativeCellSize,
  encodeKittyDeleteImage,
  encodeKittyDeletePlacement,
  encodeKittyPlacement,
  encodeKittyTransmit,
  parseKittyApc,
} from '../../src/tui/graphics/kitty-native.ts'

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function longBase64(chars: number): string {
  // A multiple of 4 so every non-final chunk stays a legal base64 boundary.
  return 'A'.repeat(Math.ceil(chars / 4) * 4)
}

test('a single-chunk transmission is one quiet transmit command', () => {
  const chunks = encodeKittyTransmit(TINY_PNG, 42)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0], `${KITTY_APC_INTRODUCER}a=t,f=100,i=42,q=2;${TINY_PNG}${KITTY_APC_TERMINATOR}`)
  const parsed = parseKittyApc(chunks[0]!)
  assert.ok(parsed)
  assert.equal(parsed.controls.a, 't')
  assert.equal(parsed.controls.f, '100')
  assert.equal(parsed.controls.i, '42')
  assert.equal(parsed.controls.q, '2')
  assert.equal(parsed.payload, TINY_PNG)
})

test('every chunk of a split transmission is quiet, including the final one', () => {
  const payload = longBase64(KITTY_TRANSMIT_CHUNK_CHARS * 2 + 128)
  const chunks = encodeKittyTransmit(payload, 7)
  assert.equal(chunks.length, 3)
  const parsed = chunks.map((chunk) => {
    const command = parseKittyApc(chunk)
    assert.ok(command, `chunk parses: ${chunk.slice(0, 24)}`)
    return command
  })
  // The first chunk carries the full command set; continuations carry only m/q.
  assert.equal(parsed[0]!.controls.a, 't')
  assert.equal(parsed[0]!.controls.f, '100')
  assert.equal(parsed[0]!.controls.i, '7')
  assert.equal(parsed[0]!.controls.m, '1')
  assert.equal(parsed[1]!.controls.a, undefined, 'a continuation never repeats the action')
  assert.equal(parsed[1]!.controls.m, '1')
  assert.equal(parsed[2]!.controls.m, '0')
  for (const [index, command] of parsed.entries()) {
    assert.equal(command.controls.q, '2', `chunk ${index} is silent`)
    assert.ok(command.payload.length <= KITTY_TRANSMIT_CHUNK_CHARS, `chunk ${index} stays within the ceiling`)
    assert.equal(command.payload.length % 4, 0, `chunk ${index} is a legal base64 boundary`)
  }
  assert.equal(parsed.map((command) => command.payload).join(''), payload, 'the payload round-trips')
  assert.ok(chunks.every((chunk) => !chunk.includes('a=T')), 'no combined transmit+place form')
})

test('the placement anchor keeps the fork main-screen parser contract', () => {
  const anchor = encodeKittyPlacement(99, 3, { columns: 12, rows: 4 })
  assert.equal(anchor, `${KITTY_APC_INTRODUCER}a=p,i=99,p=3,c=12,r=4,C=1,q=2;${KITTY_APC_TERMINATOR}`)
  const parsed = parseKittyApc(anchor)
  assert.ok(parsed)
  assert.equal(parsed.controls.a, 'p')
  assert.equal(parsed.controls.C, '1')
  assert.equal(parsed.controls.q, '2')
  assert.equal(parsed.payload, '')
  // The trailing `;` inside the command is what `parseKittyImageHeader()` needs:
  // without it the Main screen never tracks the id and can never delete the
  // placement (R1C P1-B).
  assert.ok(anchor.includes(',q=2;'), 'the control area is terminated by `;`')
})

test('the delete forms are scoped and quiet', () => {
  assert.equal(encodeKittyDeleteImage(5), `${KITTY_APC_INTRODUCER}a=d,d=I,i=5,q=2${KITTY_APC_TERMINATOR}`)
  assert.equal(encodeKittyDeletePlacement(5), `${KITTY_APC_INTRODUCER}a=d,d=i,i=5,q=2${KITTY_APC_TERMINATOR}`)
  for (const wire of [encodeKittyDeleteImage(5), encodeKittyDeletePlacement(5)]) {
    assert.ok(!wire.includes('d=A'), 'never a global image delete')
    assert.ok(!wire.includes('d=a'), 'never a global placement delete')
    assert.equal(parseKittyApc(wire)?.controls.q, '2')
  }
})

test('a malformed or foreign APC never parses as a graphics command', () => {
  assert.equal(parseKittyApc(''), undefined)
  assert.equal(parseKittyApc('\x1b_Ga=p,i=1;\x1b'), undefined, 'missing ST')
  assert.equal(parseKittyApc('\x1b_Ga=p,i=1;\x1b\\extra'), undefined)
  assert.equal(parseKittyApc('\x1b_Ga=p,i=1;\x1b[0m'), undefined)
})

/**
 * The cross-check: at every width the managed geometry must equal what the
 * real fork `Image.render()` emitted for the same source, ceiling and cells.
 */
test('the native geometry matches the fork Image placement at every width', () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const cell = { widthPx: 9, heightPx: 18 }
  const cases = [
    { widthPx: 800, heightPx: 600, maxWidthCells: 40, maxHeightCells: 12 },
    { widthPx: 100, heightPx: 100, maxWidthCells: 40, maxHeightCells: 12 },
    { widthPx: 1200, heightPx: 300, maxWidthCells: 80, maxHeightCells: 12 },
    { widthPx: 300, heightPx: 1600, maxWidthCells: 20, maxHeightCells: 40 },
    { widthPx: 64, heightPx: 64, maxWidthCells: 60, maxHeightCells: undefined },
  ]
  for (const entry of cases) {
    for (const width of [24, 42, 81, 120]) {
      const image = new Image(
        TINY_PNG,
        'image/png',
        { fallbackColor: (text: string) => text },
        {
          maxWidthCells: entry.maxWidthCells,
          ...(entry.maxHeightCells === undefined ? {} : { maxHeightCells: entry.maxHeightCells }),
          imageId: 11,
        },
        { widthPx: entry.widthPx, heightPx: entry.heightPx },
      )
      const lines = image.render(width)
      const fork = parseKittyApc(lines[0]!)
      assert.ok(fork, `the fork emitted an APC at width ${width}`)
      const maxWidth = Math.max(1, Math.min(width - 2, entry.maxWidthCells))
      const defaultMaxHeight = Math.max(1, Math.ceil((maxWidth * cell.widthPx) / cell.heightPx))
      const geometry = calculateNativeCellSize(
        { widthPx: entry.widthPx, heightPx: entry.heightPx },
        maxWidth,
        entry.maxHeightCells ?? defaultMaxHeight,
        cell,
      )
      assert.equal(geometry.columns, Number(fork.controls.c), `columns at ${width}/${entry.widthPx}x${entry.heightPx}`)
      assert.equal(geometry.rows, Number(fork.controls.r), `rows at ${width}/${entry.widthPx}x${entry.heightPx}`)
      assert.equal(lines.length, geometry.rows, 'the reserved row count equals the placement rows')
    }
  }
})
