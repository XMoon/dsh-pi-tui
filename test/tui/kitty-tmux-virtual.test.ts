/**
 * Image-7B-A — the pure tmux virtual wire.
 *
 * These cases are byte-level: the placeholder grid is cross-checked against
 * Kitty's own published 2×2 example and the 32-bit id example, and the tmux
 * framing is checked to double every inner ESC inside exactly ONE DCS per APC.
 * @module @xmoon76/dsh-pi-tui/tui/kitty-tmux-virtual.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import {
  KITTY_VIRTUAL_MAX_CELLS,
  KITTY_VIRTUAL_PLACEHOLDER,
  encodeKittyPlaceholderGrid,
  encodeKittyVirtualPlacement,
  encodeTmuxPassthrough,
  hasKittyVirtualCells,
} from '../../src/tui/graphics/tmux-virtual.ts'

const P = KITTY_VIRTUAL_PLACEHOLDER
const diacritic = (index: number): string => {
  const table = [
    0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d, 0x33e, 0x33f,
  ]
  return String.fromCodePoint(table[index]!)
}

test('one complete APC is wrapped in its own tmux DCS with every inner ESC doubled', () => {
  const apc = '\x1b_Ga=t,f=100,i=7,q=2;AAAA\x1b\\'
  assert.equal(
    encodeTmuxPassthrough(apc),
    '\x1bPtmux;\x1b\x1b_Ga=t,f=100,i=7,q=2;AAAA\x1b\x1b\\\x1b\\',
  )
})

test('the framer refuses a non-APC or several commands in one DCS', () => {
  assert.throws(() => encodeTmuxPassthrough('plain text'), /one complete Kitty APC/)
  assert.throws(() => encodeTmuxPassthrough('\x1b_Ga=t,i=1,q=2;AAAA\x1b'), /one complete Kitty APC/)
  const two = '\x1b_Ga=t,i=1,q=2;AAAA\x1b\\\x1b_Ga=p,i=1,q=2;\x1b\\'
  assert.throws(() => encodeTmuxPassthrough(two), /exactly one Kitty APC/)
})

test('the virtual placement is the fixed U=1 prototype with a terminated control area', () => {
  assert.equal(
    encodeKittyVirtualPlacement(42, 3, 2, 2),
    '\x1b_Ga=p,U=1,i=42,p=3,c=2,r=2,q=2;\x1b\\',
  )
})

test('the 2×2 placeholder grid matches Kitty\'s published example', () => {
  const grid = encodeKittyPlaceholderGrid(42, 1, 2, 2)
  const foreground = '\x1b[38;2;0;0;42m'
  const underline = '\x1b[58:2::0:0:1m'
  const reset = '\x1b[39;59m'
  assert.deepEqual(grid, [
    foreground + underline + P + diacritic(0) + diacritic(0) + diacritic(0)
      + P + diacritic(0) + diacritic(1) + diacritic(0) + reset,
    foreground + underline + P + diacritic(1) + diacritic(0) + diacritic(0)
      + P + diacritic(1) + diacritic(1) + diacritic(0) + reset,
  ])
  assert.equal(visibleWidth(grid[0]!), 2, 'each real text cell is one terminal column')
})

test('an image id above 24 bits is carried by the third diacritic, never truncated', () => {
  const imageId = 33554474 // 42 + (2 << 24), Kitty's own high-id example
  const grid = encodeKittyPlaceholderGrid(imageId, 1, 2, 1)
  assert.ok(grid[0]!.startsWith('\x1b[38;2;0;0;42m'), 'the low 24 bits stay in the foreground color')
  assert.ok(grid[0]!.includes(P + diacritic(0) + diacritic(0) + diacritic(2)), 'the upper byte is diacritic 2')
  assert.equal(visibleWidth(grid[0]!), 2)
})

test('the upper id byte covers the whole 32-bit range', () => {
  const grid = encodeKittyPlaceholderGrid(0xffffffff, 0xffffff, 1, 1)
  assert.ok(grid[0]!.startsWith('\x1b[38;2;255;255;255m'))
  const upper = String.fromCodePoint(0xa8e5) // table index 255
  assert.ok(grid[0]!.includes(P + diacritic(0) + diacritic(0) + upper), '255 is addressable')
})

test('the encoder accepts the 297 boundary and rejects anything outside it', () => {
  assert.equal(KITTY_VIRTUAL_MAX_CELLS, 297)
  const wide = encodeKittyPlaceholderGrid(42, 1, KITTY_VIRTUAL_MAX_CELLS, 1)
  assert.equal(visibleWidth(wide[0]!), 297)
  assert.ok(wide[0]!.includes(P + diacritic(0) + String.fromCodePoint(0x1d244) + diacritic(0)),
    'column 296 is the last addressable cell')

  assert.throws(() => encodeKittyPlaceholderGrid(42, 1, 298, 1), /columns/)
  assert.throws(() => encodeKittyPlaceholderGrid(42, 1, 1, 298), /rows/)
  assert.throws(() => encodeKittyPlaceholderGrid(42, 1, 0, 1), /columns/)
  assert.throws(() => encodeKittyPlaceholderGrid(42, 1, 1, -3), /rows/)
  assert.throws(() => encodeKittyVirtualPlacement(42, 1, 298, 1), /columns/)
  assert.throws(() => encodeKittyVirtualPlacement(42, 1, 1, 298), /rows/)
  assert.throws(() => encodeKittyVirtualPlacement(42, 1, 1.5, 1), /columns/,
    'the encoder never silently floors a fractional cell count')
})

test('every grid row ends with an explicit foreground/underline reset', () => {
  const grid = encodeKittyPlaceholderGrid(0x1234, 0x56, 3, 2)
  assert.equal(grid.length, 2)
  for (const line of grid) {
    assert.ok(line.endsWith('\x1b[39;59m'), 'no color may leak into the next screen row')
    assert.equal(visibleWidth(line), 3)
  }
})

test('the managed-cell test needs the COMPLETE three-diacritic structure', () => {
  const grid = encodeKittyPlaceholderGrid(0x12345678, 7, 40, 2)
  assert.equal(hasKittyVirtualCells(grid[0]!), true, 'a real grid row is a cell run')
  assert.equal(hasKittyVirtualCells(grid[1]!), true, 'every grid row is a cell run')

  // A bare placeholder codepoint is ordinary text: no row/column/high-byte marks.
  assert.equal(hasKittyVirtualCells(`plain ${P} text`), false)
  // Even ONE missing diacritic is not a cell (a user cannot produce the triple).
  const cell = [...grid[0]!.slice(grid[0]!.indexOf(P))].slice(0, 4).join('')
  assert.equal(hasKittyVirtualCells(P), false)
  assert.equal(hasKittyVirtualCells(cell), true, 'the fixture really is one cell')
  assert.equal(hasKittyVirtualCells(cell.slice(0, 3)), false, 'an incomplete cell is not a cell')

  // A MID-ROW tail (the writer cut after the colour prefix) still carries
  // complete cells, so it is still recognised without any colour bytes.
  const row = grid[1]!
  const cut = row.indexOf(P) + 40
  const tail = row.slice(cut)
  assert.equal(tail.includes('38;2;'), false, 'fixture: the tail has no colour prefix')
  assert.equal(hasKittyVirtualCells(tail), true, 'the mid-row tail is still a managed cell run')
})
