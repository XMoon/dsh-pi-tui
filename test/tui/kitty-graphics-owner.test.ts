/**
 * Image-7A PR1 — the graphics owner and its terminal gate.
 *
 * These are the permission tests: only the Core may free its own image data,
 * a legacy writer's deletion intent becomes a scoped placement removal, a
 * foreign owner is never touched, and every re-transmission happens after the
 * clear that invalidated the data and before the placement that needs it.
 * @module @xmoon76/dsh-pi-tui/tui/kitty-graphics-owner.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { setCapabilities, type Terminal, type TerminalProgressState } from '@xmoon76/pi-tui'
import {
  KittyGraphicsCore,
  MAX_RESIDENT_IMAGES,
  MAX_RESIDENT_PAYLOAD_BYTES,
  type KittyGraphicsEvent,
} from '../../src/tui/graphics/kitty-core.ts'
import {
  encodeKittyDeleteImage,
  encodeKittyDeletePlacement,
  encodeKittyPlacement,
  parseKittyApc,
} from '../../src/tui/graphics/kitty-native.ts'
import { KittyTerminalFacade } from '../../src/tui/graphics/kitty-terminal.ts'
import { NativeKittyImage, admitsNativeKitty } from '../../src/tui/graphics/native-image.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

class RecordingTerminal implements Terminal {
  readonly writes: string[] = []
  columns = 80
  rows = 24
  kittyProtocolActive = true

  get text(): string {
    return this.writes.join('')
  }

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data)
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
  setProgressState(_state: TerminalProgressState): void {}
}

function harness(options: { onEvent?: (event: KittyGraphicsEvent) => void } = {}) {
  const terminal = new RecordingTerminal()
  const core = new KittyGraphicsCore(options)
  const facade = new KittyTerminalFacade(terminal, core)
  return { terminal, core, facade }
}

function source(payload = PNG, widthPx = 64, heightPx = 64) {
  return { pngBase64: payload, widthPx, heightPx }
}

function count(haystack: string, needle: string): number {
  let total = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    total += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return total
}

test('a placement transmits once, then only re-places', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const lines = component.render(80)
  facade.write(lines.join('\r\n'))
  const first = terminal.text
  assert.equal(count(first, 'a=t,f=100'), 1, 'the payload is transmitted')
  assert.equal(count(first, 'a=p,'), 1, 'one placement for the occurrence')
  assert.ok(first.indexOf('a=t,f=100') < first.indexOf('a=p,'), 'the transmission is emitted before the placement')
  assert.equal(count(first, 'q=2'), count(first, 'a=t,f=100') + count(first, 'a=p,'), 'every APC is quiet')

  // A second, unchanged frame re-emits the same anchor line: the screen's own
  // line dedupe may write it, but the data must already be resident.
  terminal.writes.length = 0
  facade.write(lines.join('\r\n'))
  assert.equal(count(terminal.text, 'a=t,f=100'), 0, 'no re-transmission for a resident image')
  assert.equal(count(terminal.text, 'a=p,'), 1, 'the placement is still written')
})

test('a real clear invalidates the data and the next placement re-transmits after it', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  facade.write(anchor)
  assert.equal(count(terminal.text, 'a=t,f=100'), 1)

  terminal.writes.length = 0
  facade.write(`\x1b[2J\x1b[H\x1b[3J${anchor}`)
  const text = terminal.text
  const clearAt = text.indexOf('\x1b[2J')
  const transmitAt = text.indexOf('a=t,f=100')
  const placeAt = text.indexOf('a=p,')
  assert.ok(clearAt !== -1, 'the clear reaches the terminal')
  assert.ok(transmitAt > clearAt, 'the re-transmission happens AFTER the invalidating clear')
  assert.ok(placeAt > transmitAt, 'and BEFORE the placement')
  assert.equal(count(text, 'a=t,f=100'), 1, 'exactly one re-transmission')
})

test('a 3J-only clear is a data-invalidating clear (measured on Kitty 0.41.1)', () => {
  // Stage-0 S0-4 measured a bare `3J` in a fresh state: the visible screen is
  // empty AND the old image data paints nothing until the payload is sent
  // again. The gate must therefore re-transmit after it, exactly like `2J`.
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  facade.write(anchor)
  terminal.writes.length = 0
  facade.write(`\x1b[3J${anchor}`)
  assert.equal(count(terminal.text, 'a=t,f=100'), 1, 'the payload is sent again')
  assert.ok(terminal.text.indexOf('a=t,f=100') > terminal.text.indexOf('\x1b[3J'), 'after the clear')
  assert.ok(terminal.text.indexOf('a=t,f=100') < terminal.text.indexOf('a=p,'), 'and before the placement')
})

test('a legacy per-id delete of a managed image removes the placement, never the data', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  facade.write(anchor)
  const id = component.imageId!

  terminal.writes.length = 0
  facade.write(encodeKittyDeleteImage(id))
  assert.equal(terminal.text, encodeKittyDeletePlacement(id), 'translated to a scoped placement removal')
  assert.ok(!terminal.text.includes('d=I'), 'the writer may not free the data')

  // The image was hidden, not retired: re-showing it re-places the resident data.
  terminal.writes.length = 0
  facade.write(anchor)
  assert.equal(count(terminal.text, 'a=t,f=100'), 0, 'a hidden image keeps its resident data')
  assert.equal(count(terminal.text, 'a=p,'), 1)
})

test('a foreign per-id delete passes through untouched', () => {
  const { terminal, facade } = harness()
  const foreign = encodeKittyDeleteImage(0xabcdef)
  facade.write(foreign)
  assert.equal(terminal.text, foreign)
})

test('global deletes are translated into scoped own-id operations only', () => {
  const { terminal, facade, core } = harness()
  const first = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const second = new NativeKittyImage(core, source('AAAA', 32, 32), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(first.render(80).join('\r\n') + second.render(80).join('\r\n'))
  const ids = [first.imageId!, second.imageId!]

  terminal.writes.length = 0
  facade.write('\x1b_Ga=d,d=a,q=2\x1b\\')
  assert.ok(!terminal.text.includes('d=a'), 'the global placement delete never reaches the terminal')
  for (const id of ids) assert.ok(terminal.text.includes(encodeKittyDeletePlacement(id)), `scoped removal for ${id}`)

  terminal.writes.length = 0
  facade.write('\x1b_Ga=d,d=A,q=2\x1b\\')
  assert.ok(!terminal.text.includes('d=A'), 'the global image delete never reaches the terminal')
  for (const id of ids) assert.ok(terminal.text.includes(encodeKittyDeleteImage(id)), `scoped retire for ${id}`)
})

test('the gate joins a graphics command split across writes', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  const cut = Math.floor(anchor.length / 2)
  facade.write(`prefix${anchor.slice(0, cut)}`)
  assert.equal(terminal.text, 'prefix', 'an incomplete command is not forwarded')
  facade.write(`${anchor.slice(cut)}suffix`)
  assert.ok(terminal.text.startsWith('prefix'), 'the text before the command is never held back')
  assert.ok(terminal.text.endsWith(`${anchor}suffix`), 'the joined command and its tail follow in order')
  assert.equal(count(terminal.text, 'a=t,f=100'), 1, 'the injection still happens exactly once')
})

test('the gate joins a plain clear split across writes', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  facade.write(anchor)
  terminal.writes.length = 0
  facade.write('\x1b[2')
  facade.write(`J${anchor}`)
  assert.equal(terminal.text, `\x1b[2J${terminal.text.slice('\x1b[2J'.length)}`, 'the clear is replayed verbatim')
  assert.ok(terminal.text.indexOf('a=t,f=100') > terminal.text.indexOf('\x1b[2J'))
})

test('a screen-buffer switch invalidates residency', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  facade.write(anchor)
  terminal.writes.length = 0
  facade.write(`\x1b[?1049h${anchor}`)
  assert.equal(count(terminal.text, 'a=t,f=100'), 1, 'the new buffer has no copy of the data')
})

test('retirement is queued, emitted by the next write, and never reuses the id', () => {
  const { terminal, facade, core } = harness()
  const first = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const firstId = first.render(80), firstImageId = first.imageId!
  facade.write(firstId.join('\r\n'))
  first.dispose()
  terminal.writes.length = 0
  facade.write('after')
  assert.ok(terminal.text.startsWith(encodeKittyDeleteImage(firstImageId)), 'the hard retire precedes the frame')
  assert.ok(terminal.text.endsWith('after'), 'the frame is still written')

  const second = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  second.render(80)
  assert.notEqual(second.imageId, firstImageId, 'a retired id is never handed out again')
})

test('the budget falls back instead of evicting a possibly visible image', () => {
  const { core } = harness()
  const images = []
  for (let index = 0; index < MAX_RESIDENT_IMAGES; index++) {
    const image = core.register(source(PNG, 4, 4))
    assert.ok(image, `image ${index} admits`)
    images.push(image)
  }
  assert.equal(core.residentImageCount, MAX_RESIDENT_IMAGES)
  assert.equal(core.register(source(PNG, 4, 4)), undefined, 'the next occurrence falls back')
  // Dropping one occurrence makes room again; nothing was force-deleted.
  core.retire(images[0]!)
  core.drain()
  assert.ok(core.register(source(PNG, 4, 4)), 'a released slot is reusable')
})

test('the payload budget refuses an oversized resident set', () => {
  const { core } = harness()
  const big = 'A'.repeat(Math.floor(MAX_RESIDENT_PAYLOAD_BYTES / 2) + 4)
  assert.ok(core.register(source(big, 4, 4)))
  assert.equal(core.register(source(big, 4, 4)), undefined, 'the payload ceiling is enforced')
})

test('stop releases uploaded-but-never-placed images and preserves painted ones', () => {
  const { terminal, facade, core } = harness()
  const painted = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(painted.render(80).join('\r\n'))
  const paintedId = painted.imageId!
  // An occurrence whose bytes were offered but whose placement never landed.
  const unplaced = core.register(source('AAAA', 8, 8))!
  facade.write(core.transmissionFor(unplaced.imageId))

  terminal.writes.length = 0
  facade.stop()
  assert.equal(terminal.text, encodeKittyDeleteImage(unplaced.imageId), 'only the never-visible data is freed')
  assert.ok(!terminal.text.includes(`d=I,i=${paintedId}`), 'a painted scrollback image is left to the screen policy')
})

test('the alternate screen release at stop frees the managed ids before the terminal stops', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(component.render(80).join('\r\n'))
  const id = component.imageId!
  terminal.writes.length = 0
  // The fork's alternate screen emits its global release in beforeTerminalStop.
  facade.write('\x1b[?2026h\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?2026l')
  facade.stop()
  assert.ok(terminal.writes.join('').includes(encodeKittyDeleteImage(id)), 'the own image is released')
  assert.ok(!terminal.writes.join('').includes('d=A'), 'never the global form')
})

test('native admission requires the one measured Kitty topology', () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'kitty' }), true)
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'Kitty' }), true, 'the identity compare is case-insensitive')
  assert.equal(admitsNativeKitty({ KITTY_WINDOW_ID: '3' }), true)
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'ghostty', GHOSTTY_RESOURCES_DIR: '/x' }), false,
    'no measured evidence for another Kitty-compatible terminal')
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'wezterm', WEZTERM_PANE: '1' }), false)
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'kitty', TMUX: '/tmp/tmux-1000/default,1,0' }), false)
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'kitty', ZELLIJ: '1' }), false)
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'kitty', STY: '1' }), false)
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'kitty', TERM: 'tmux-256color' }), false)
  assert.equal(admitsNativeKitty({ KITTY_WINDOW_ID: '1', TERM: 'screen-256color' }), false)
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'herdr', KITTY_WINDOW_ID: '1' }), false)
  assert.equal(admitsNativeKitty({ PI_IMAGE_PROTOCOL: 'kitty' }), false,
    'a legacy env override cannot manufacture the Kitty identity evidence')
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: true })
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'kitty' }), false, 'the capability must be Kitty')
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'kitty' }), false)
})

test('ordinary text and OSC sequences pass through byte-for-byte', () => {
  const { terminal, facade } = harness()
  const text = 'hello \x1b[31mred\x1b[0m \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ \x1b]52;c;YWJj\x07'
  facade.write(text)
  assert.equal(terminal.text, text)
})
