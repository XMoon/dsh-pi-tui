/**
 * Image-8 / I8-2A — the ONE Direct SIXEL graphics owner.
 *
 * These cases prove the product-level contract, not the codec's pixel math
 * (that is `sixel-encoder.test.ts`) and not the fork Screen's physics (that is
 * `packages/pi-tui/test/tui-sixel-*.test.ts`):
 *
 * - a raster is painted ONLY after three real facts (DA1, cell reply, OSC 11
 *   background) have all arrived for the CURRENT screen;
 * - the Screen's trust port recognises the EXACT encoded DCS and reports the
 *   encoder's real footprint, never a requested ceiling;
 * - a visible crop is a NEW bounded encode of the same source, never a sliced
 *   DCS string, and a superseded variant never paints;
 * - a late settle (disposed occurrence, changed screen, changed background)
 *   cannot register anything;
 * - the registry refuses a new raster rather than evicting one the current
 *   frame is painting.
 *
 * Every pixel assertion goes through the independent decoder in
 * `test/support/sixel-oracle.ts`.
 * @module @xmoon76/dsh-pi-tui/client/sixel-image.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SixelEncodeBusyError,
  SixelEncodeRejectedError,
  SixelEncoder,
} from '../../src/client/media/sixel/encode.ts'
import { SIXEL_MAX_QUEUED_JOBS } from '../../src/client/media/sixel/types.ts'
import {
  createDirectSixelGraphics,
  createSixelGraphicsWithAdmission,
  SIXEL_ENCODE_ATTEMPT_LIMIT,
  SIXEL_REGISTRY_MAX_VARIANTS,
  type DirectSixelGraphics,
  type SixelScreenObservation,
} from '../../src/tui/graphics/sixel-image.ts'
import type { PixelBody } from '../../src/tui/graphics/native-image.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { decodeSixel, pixelAt } from '../support/sixel-oracle.ts'

/** A Direct terminal whose DA1 attribute 4 arrives when the test says so. */
class ScriptedSixelTerminal extends VirtualTerminal {
  private listeners = new Set<(supported: boolean) => void>()

  onSixelSupport(listener: (supported: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  declareSixel(supported: boolean): void {
    for (const listener of [...this.listeners]) listener(supported)
  }
}

/**
 * The active screen's observation face.
 *
 * It answers with the values a real screen reads: `queryCellSizeForSixel` sends
 * one `CSI 16t` (counted), the cell reply arrives through the ONE parser, and
 * the background resolves from the screen's own OSC 11 probe.
 */
class ScriptedScreen implements SixelScreenObservation {
  cellQueries = 0
  cellWidthPx = 10
  cellHeightPx = 20
  /** Whether the terminal answers `CSI 16t` at all (a dead geometry reply is a case). */
  autoReplyCell = true
  background: { r: number; g: number; b: number } | undefined
  private readonly listeners = new Set<(cell: { widthPx: number; heightPx: number }) => void>()

  queryCellSizeForSixel(): void {
    this.cellQueries += 1
    // A real terminal ANSWERS `CSI 16t`; this one does too, on the next turn so the
    // owner's query path is never re-entered synchronously.
    if (this.autoReplyCell) setImmediate(() => this.replyCell(this.cellWidthPx, this.cellHeightPx))
  }

  onCellSizeObserved(listener: (cell: { widthPx: number; heightPx: number }) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async queryTerminalBackgroundColor(_options: { timeoutMs: number }): Promise<{ r: number; g: number; b: number } | undefined> {
    return this.background
  }

  replyCell(widthPx: number, heightPx: number): void {
    for (const listener of [...this.listeners]) listener({ widthPx, heightPx })
  }
}

/**
 * Poll a predicate until it holds.
 *
 * The encode lane's settle time is the real codec's (sharp import + worker
 * spawn), so a fixed sleep would either be flaky or waste seconds. The
 * predicate never mutates owner state.
 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Wait for exactly one more readiness notification (i.e. one settle repaint). */
async function waitForRepaint(harness: { notifications(): number }, label: string): Promise<void> {
  const before = harness.notifications()
  await waitUntil(() => harness.notifications() > before, label)
}

async function pngFromRgba(rgba: Uint8Array, width: number, height: number): Promise<string> {
  const { default: sharp } = await import('sharp')
  const buffer = await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).png().toBuffer()
  return buffer.toString('base64')
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

interface Harness {
  readonly graphics: DirectSixelGraphics
  readonly terminal: ScriptedSixelTerminal
  readonly screen: ScriptedScreen
  /** Every readiness notification (repaint request) the owner produced so far. */
  notifications(): number
}

/** Build the owner with the three facts already complete. */
async function readyHarness(t: test.TestContext, options: { rows?: number; background?: { r: number; g: number; b: number } } = {}): Promise<Harness> {
  const home = testLifecycle(t).tempDir('sixel-image-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const terminal = new ScriptedSixelTerminal(120, options.rows ?? 24)
  const screen = new ScriptedScreen()
  screen.background = options.background ?? { r: 0x28, g: 0x2c, b: 0x34 }
  const state = { notifications: 0 }
  const graphics = createDirectSixelGraphics(terminal, { TERM: 'xterm-256color' }, () => {
    state.notifications += 1
  })
  assert.notEqual(graphics, undefined)
  graphics!.observeScreen(screen, terminal.columns, terminal.rows)
  terminal.declareSixel(true)
  screen.replyCell(10, 20)
  const harness: Harness = {
    graphics: graphics!,
    terminal,
    screen,
    notifications: () => state.notifications,
  }
  await waitUntil(() => graphics!.canPaint(), 'three verified facts')
  return harness
}

/**
 * Drive one Screen frame for a single image: hand its candidate to the trust
 * port, materialize what the owner grants, and commit the painted rasters.
 *
 * This is the same three calls a real Screen makes (`reconcileVisible` →
 * `materialize` → `framePainted`); a test that instead read `render()` as if it
 * returned pixels would bypass the visibility contract under test.
 */
function paint(harness: Harness, image: PixelBody, width: number, window?: { top: number; rows: number }): string[] {
  const lines = image.render(width)
  const port = harness.graphics.screen
  const token = lines[0] ?? ''
  const info = port.candidate(token)
  if (info === undefined) return lines
  const cropTopRows = window?.top ?? 0
  const visibleRows = window?.rows ?? info.layoutRows
  port.reconcileVisible(harness.screen, [{ line: token, cropTopRows, visibleRows, physicalRow: 0 }])
  const out = [...lines]
  const dcs = port.materialize(token, cropTopRows, visibleRows)
  if (dcs === undefined) {
    out[0] = info.fallback
    port.framePainted(harness.screen, [])
    return out
  }
  out[0] = dcs
  port.framePainted(harness.screen, [{ line: token, dcs, cropTopRows, visibleRows: port.footprint(dcs)?.rows ?? visibleRows, emitted: true }])
  return out
}

/**
 * Paint ONE frame holding several occurrences (the Screen reconciles every
 * visible candidate together; painting them one at a time would revoke the
 * others on each frame and churn the registry).
 */
function paintFrame(harness: Harness, images: readonly PixelBody[], width: number): string[][] {
  const frames = images.map(image => image.render(width))
  const port = harness.graphics.screen
  const demands: Array<{ line: string; cropTopRows: number; visibleRows: number; physicalRow: number }> = []
  images.forEach((_image, index) => {
    const token = frames[index]?.[0] ?? ''
    const info = port.candidate(token)
    if (info === undefined) return
    demands.push({ line: token, cropTopRows: 0, visibleRows: info.layoutRows, physicalRow: index })
  })
  // Bottom-up: the newest content wins a contested slot (the addendum's priority).
  const ordered = [...demands].sort((left, right) => right.physicalRow - left.physicalRow)
  port.reconcileVisible(harness.screen, ordered)
  const out = frames.map(frame => [...frame])
  const retained: Array<{ line: string; dcs: string; cropTopRows: number; visibleRows: number; emitted: boolean }> = []
  for (const demand of ordered) {
    const index = demand.physicalRow
    const dcs = port.materialize(demand.line, 0, demand.visibleRows)
    if (dcs === undefined) {
      out[index]![0] = port.candidate(demand.line)!.fallback
      continue
    }
    out[index]![0] = dcs
    retained.push({ line: demand.line, dcs, cropTopRows: 0, visibleRows: port.footprint(dcs)?.rows ?? demand.visibleRows, emitted: true })
  }
  port.framePainted(harness.screen, retained)
  return out
}

const TWO_BAND_PNG = async (): Promise<string> =>
  pngFromRgba(fill(40, 40, (_x, y) => (y < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 40, 40)

test('an admitted terminal paints the exact trusted DCS and its REAL footprint', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const image = harness.graphics.image(
    { pngBase64: await TWO_BAND_PNG(), widthPx: 40, heightPx: 40 },
    { maxWidthCells: 8, maxHeightCells: 4, fallback: 'fallback' },
  )
  // Frame 1: admission is synchronous, the encode is not — a text row only.
  const repaint = harness.notifications()
  assert.equal(paint(harness, image, 40)[0], 'fallback')
  assert.equal(image.paintedBodyAt?.(40), undefined, 'a pending encode registers no body')
  await waitUntil(() => harness.notifications() > repaint, 'the first encode settle')

  const lines = paint(harness, image, 40)
  const dcs = lines[0]!
  assert.ok(dcs.startsWith('\x1bP'), 'the anchor is one complete DCS')
  const footprint = harness.graphics.screen.footprint(dcs)
  assert.notEqual(footprint, undefined, 'the Screen trust port recognises the exact encoded string')
  const body = image.paintedBodyAt?.(40)
  assert.deepEqual(body, { width: 40, columns: footprint!.columns, rows: footprint!.rows })
  assert.equal(lines.length, footprint!.rows, 'the body carries the footprint height, one DCS plus blank rows')
  assert.ok(lines.slice(1).every(line => line === ''), 'only the anchor row carries bytes')

  const decoded = decodeSixel(dcs)
  assert.equal(decoded.width, footprint!.columns * 10, 'the real footprint covers exactly the encoded width')
  assert.equal(decoded.height % 6, 0, 'a SIXEL raster is always a whole number of 6 px bands')
  assert.ok(
    decoded.height <= footprint!.rows * 20 && decoded.height > (footprint!.rows - 1) * 20,
    `the encoded height ${decoded.height} must sit inside ${footprint!.rows} cell rows`,
  )
  const [topR] = pixelAt(decoded, 4, 0)
  assert.ok(topR > 200, 'the first band is red')

  // An unrelated DCS is NOT trusted, however well formed it looks.
  assert.equal(harness.graphics.screen.footprint('\x1bP0;1;0q"1;1;10;10#1;2;100;0;0!10~\x1b\\'), undefined)
  // Nor is a text line that merely LOOKS like the old predictable marker: the
  // token carries a per-owner nonce, so ordinary content cannot be promoted.
  assert.equal(harness.graphics.screen.candidate('\u2063SIXC:1\u2063'), undefined, 'a forged marker is not a candidate')
})

test('every missing fact paints text instead, and no geometry query precedes the DA1', async (t) => {
  const home = testLifecycle(t).tempDir('sixel-image-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const png = await TWO_BAND_PNG()

  // (a) no DA1 answer at all.
  {
    const terminal = new ScriptedSixelTerminal()
    const screen = new ScriptedScreen()
    screen.background = { r: 0, g: 0, b: 0 }
    const graphics = createDirectSixelGraphics(terminal, { TERM: 'xterm-256color' })!
    t.after(() => graphics.dispose())
    graphics.observeScreen(screen, terminal.columns, terminal.rows)
    screen.replyCell(10, 20)
    // reason: a NEGATIVE observation window — the contract is that NOTHING happens here,
    // so there is no positive state change to await; the window is the assertion's bound.
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(graphics.canPaint(), false, 'a pending DA1 is not permission')
    const image = graphics.image({ pngBase64: png, widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, fallback: 'pending' })
    assert.deepEqual(image.render(40), ['pending'])
    assert.equal(image.paintedBodyAt?.(40), undefined)
    assert.equal(screen.cellQueries, 0, 'the candidate must not spend a geometry query before the terminal declares SIXEL')
  }

  // (b) DA1 admitted, no real `CSI 6;h;w t` reply.
  {
    const terminal = new ScriptedSixelTerminal()
    const screen = new ScriptedScreen()
    screen.background = { r: 0, g: 0, b: 0 }
    // This terminal never answers `CSI 16t`, so the default 9x18 stays unverified.
    screen.autoReplyCell = false
    const graphics = createDirectSixelGraphics(terminal, { TERM: 'xterm-256color' })!
    t.after(() => graphics.dispose())
    graphics.observeScreen(screen, terminal.columns, terminal.rows)
    terminal.declareSixel(true)
    // reason: a NEGATIVE observation window — the contract is that NOTHING happens here,
    // so there is no positive state change to await; the window is the assertion's bound.
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(screen.cellQueries, 1, 'admission triggers exactly one real geometry query')
    assert.equal(graphics.canPaint(), false, 'a default 9x18 cell is not a verified fact')
    const image = graphics.image({ pngBase64: png, widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, fallback: 'pending' })
    assert.deepEqual(image.render(40), ['pending'])
  }

  // (c) DA1 + cell, but the OSC 11 background timed out (resolves undefined).
  {
    const terminal = new ScriptedSixelTerminal()
    const screen = new ScriptedScreen()
    screen.background = undefined
    const graphics = createDirectSixelGraphics(terminal, { TERM: 'xterm-256color' })!
    t.after(() => graphics.dispose())
    graphics.observeScreen(screen, terminal.columns, terminal.rows)
    terminal.declareSixel(true)
    screen.replyCell(10, 20)
    // reason: a NEGATIVE observation window — the contract is that NOTHING happens here,
    // so there is no positive state change to await; the window is the assertion's bound.
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(graphics.canPaint(), false, 'a background observation that timed out is not a guessed black')
    const image = graphics.image({ pngBase64: png, widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, fallback: 'pending' })
    assert.deepEqual(image.render(40), ['pending'])
  }
})

test('a statically excluded topology gets no handle at all', () => {
  const terminal = new ScriptedSixelTerminal()
  for (const environment of [
    { TERM: 'xterm-256color', PI_IMAGE_PROTOCOL: 'none' },
    { TERM: 'xterm-256color', PI_IMAGE_PROTOCOL: '0' },
    { TERM: 'xterm-256color', PI_IMAGE_PROTOCOL: 'kitty' },
    { TERM: 'xterm-256color', TMUX: '/tmp/tmux' },
    { TERM: 'xterm-256color', ZELLIJ: '1' },
    { TERM: 'xterm-256color', TERM_PROGRAM: 'herdr' },
    { TERM: 'screen-256color' },
  ] as NodeJS.ProcessEnv[]) {
    assert.equal(
      createDirectSixelGraphics(terminal, environment),
      undefined,
      `SIXEL must not even become a candidate for ${JSON.stringify(environment)}`,
    )
  }
})

test('a bottom-clipped block is a NEW encode of its own source, never a sliced DCS', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const image = harness.graphics.image(
    { pngBase64: await TWO_BAND_PNG(), widthPx: 40, heightPx: 40 },
    { maxWidthCells: 8, maxHeightCells: 4, fallback: 'fallback' },
  )
  paint(harness, image, 40)
  await waitForRepaint(harness, 'the full encode')
  const full = paint(harness, image, 40)[0]!
  const footprint = harness.graphics.screen.footprint(full)!
  assert.equal(footprint.rows, 2)

  // A window that covers the whole block needs no variant at all: the port
  // answers with the SAME raster, so the Screen repaints nothing new.
  assert.equal(harness.graphics.screen.crop(full, 0, 2), full)
  assert.equal(harness.graphics.screen.crop(full, 0, 9), full)

  // Only the first cell row is visible: ONE bounded encode of the same source.
  const beforeClip = harness.notifications()
  assert.equal(harness.graphics.screen.crop(full, 0, 1), undefined, 'a missing variant paints nothing this frame')
  await waitUntil(() => harness.notifications() > beforeClip, 'the bottom-crop variant')
  const clipped = harness.graphics.screen.crop(full, 0, 1)
  assert.notEqual(clipped, undefined)
  assert.notEqual(clipped, full, 'the variant is a different, shorter raster')
  const clippedFootprint = harness.graphics.screen.footprint(clipped!)!
  assert.deepEqual(clippedFootprint, { columns: footprint.columns, rows: 1 })
  const decoded = decodeSixel(clipped!)
  const [red, , blueChannel] = pixelAt(decoded, 4, 0)
  assert.ok(red > 200 && blueChannel < 60, 'the visible row still starts with the source top')
  assert.equal(decoded.height % 6, 0, 'the variant is still whole bands')

  // A top crop of the SECOND cell row is a different variant of the same source.
  const beforeTop = harness.notifications()
  assert.equal(harness.graphics.screen.crop(full, 1, 1), undefined)
  await waitUntil(() => harness.notifications() > beforeTop, 'the top-crop variant')
  const second = harness.graphics.screen.crop(full, 1, 1)
  assert.notEqual(second, undefined)
  const [, , secondBlue] = pixelAt(decodeSixel(second!), 4, 0)
  assert.ok(secondBlue > 200, 'cropping one cell row starts at the blue band')
  // The owner records the committed top-crop offset on the occurrence so the
  // consumer hit map can start at the real visible row.
  paint(harness, image, 40, { top: 1, rows: 1 })
  assert.equal(image.paintedBodyAt?.(40)?.cropTopRows, 1,
    'framePainted stores the committed top-crop offset on the occurrence')

  // Out-of-contract bounds are refused instead of clamped silently.
  assert.equal(harness.graphics.screen.crop(full, 2, 1), undefined)
  assert.equal(harness.graphics.screen.crop(full, -1, 1), undefined)
  assert.equal(harness.graphics.screen.crop(full, 0, 0), undefined)
  assert.equal(harness.graphics.screen.crop(full, 0, 1.5), undefined)
})

test('the painted crop offset comes from the retained raster, not the current variant', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const image = harness.graphics.image(
    { pngBase64: await pngFromRgba(fill(40, 80, () => [0, 0, 0, 255]), 40, 80), widthPx: 40, heightPx: 80 },
    { maxWidthCells: 8, maxHeightCells: 4, fallback: 'fallback' },
  )

  // Establish the full raster, then two different top-crop windows that both
  // encode to the SAME DCS because the source is solid. The owner's current
  // variant will end on top=2 while the retained raster from the old frame was
  // top=1; the committed offset must follow the raster.
  const fullRepaint = harness.notifications()
  assert.equal(paint(harness, image, 40)[0], 'fallback')
  await waitUntil(() => harness.notifications() > fullRepaint, 'the full encode')
  const full = paint(harness, image, 40)[0]!
  assert.ok(full.startsWith('\x1bP'))
  const token = image.render(40)[0]!

  const cropVariant = async (top: number): Promise<string> => {
    const before = harness.notifications()
    let dcs = harness.graphics.screen.crop(full, top, 1)
    if (dcs === undefined) {
      await waitUntil(() => harness.notifications() > before, `the top-crop variant ${top}`)
      dcs = harness.graphics.screen.crop(full, top, 1)
    }
    assert.notEqual(dcs, undefined, `the top-crop variant ${top} is ready`)
    return dcs!
  }
  const first = await cropVariant(1)
  const second = await cropVariant(2)
  assert.equal(second, first, 'different offsets of a solid source encode to the same DCS')

  // The Screen retained the FIRST raster (top=1) while the owner's current
  // variant has advanced to top=2. framePainted must use the raster's offset.
  const port = harness.graphics.screen
  port.reconcileVisible(harness.screen, [{ line: token, cropTopRows: 1, visibleRows: 1, physicalRow: 0 }])
  port.framePainted(harness.screen, [{ line: token, dcs: first, cropTopRows: 1, visibleRows: 1, emitted: true }])
  assert.equal(image.paintedBodyAt?.(40)?.cropTopRows, 1,
    'the committed offset is the retained raster offset, not the current variant offset')
})

test('a superseded crop variant never paints', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const image = harness.graphics.image(
    { pngBase64: await TWO_BAND_PNG(), widthPx: 40, heightPx: 40 },
    { maxWidthCells: 8, maxHeightCells: 4, fallback: 'fallback' },
  )
  paint(harness, image, 40)
  await waitForRepaint(harness, 'the full encode')
  const full = paint(harness, image, 40)[0]!

  const before = harness.notifications()
  assert.equal(harness.graphics.screen.crop(full, 0, 1), undefined)
  assert.equal(harness.graphics.screen.crop(full, 1, 1), undefined, 'the second request supersedes the first')
  await waitUntil(() => harness.notifications() > before, 'the surviving variant')
  const second = harness.graphics.screen.crop(full, 1, 1)
  assert.notEqual(second, undefined)
  // Exactly ONE variant settled: the superseded request was aborted before it
  // could register a second raster (a second repaint would prove otherwise).
  const settled = harness.notifications()
  // reason: a NEGATIVE observation window — a late/busy settle must NOT arrive.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(harness.notifications(), settled, 'the aborted variant must not settle into a raster')
})

test('a background change re-encodes instead of reusing the old composite', async (t) => {
  const harness = await readyHarness(t, { background: { r: 0, g: 0, b: 255 } })
  t.after(() => harness.graphics.dispose())
  // A semi-transparent red over the terminal background: the painted pixel can
  // only come from the VERIFIED background.
  const png = await pngFromRgba(fill(40, 40, () => [255, 0, 0, 128]), 40, 40)
  const image = harness.graphics.image({ pngBase64: png, widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, fallback: 'fallback' })
  paint(harness, image, 40)
  await waitForRepaint(harness, 'the first encode')
  const overBlue = paint(harness, image, 40)[0]!
  const [blueR, , blueB] = pixelAt(decodeSixel(overBlue), 4, 4)
  assert.ok(blueB > 100 && blueR > 60, `the semi-transparent red must composite over the blue background, got ${blueR},${blueB}`)

  // The terminal background really changed: the readiness projection must
  // re-sample and the old composite must not be reused.
  harness.screen.background = { r: 0, g: 255, b: 0 }
  harness.graphics.resample()
  assert.equal(harness.graphics.canPaint(), false, 'a re-sample drops the old verified facts')
  assert.equal(paint(harness, image, 40)[0], 'fallback', 'no pixels while the facts are being re-verified')
  harness.screen.replyCell(10, 20)
  await waitUntil(() => harness.graphics.canPaint(), 'the new background facts')
  const beforeReencode = harness.notifications()
  // The component notices the new fact epoch on its next render and re-encodes.
  assert.equal(paint(harness, image, 40)[0], 'fallback', 'the old composite must not be reused')
  await waitUntil(() => harness.notifications() > beforeReencode, 'the re-encoded raster')
  const overGreen = paint(harness, image, 40)[0]!
  assert.notEqual(overGreen, overBlue, 'the new background must produce a new raster')
  const [greenR, greenG] = pixelAt(decodeSixel(overGreen), 4, 4)
  assert.ok(greenG > 100 && greenR > 60, `the same alpha must now composite over green, got ${greenR},${greenG}`)
})

test('an identical cell reply is the same fact and never restarts the projection', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const image = harness.graphics.image(
    { pngBase64: await TWO_BAND_PNG(), widthPx: 40, heightPx: 40 },
    { maxWidthCells: 8, fallback: 'fallback' },
  )
  paint(harness, image, 40)
  await waitForRepaint(harness, 'the first encode')
  const dcs = paint(harness, image, 40)[0]!
  const settled = harness.notifications()

  // The terminal answering the SAME geometry twice must not invalidate the
  // verified facts (that would drop every raster and re-encode the transcript).
  harness.screen.replyCell(10, 20)
  harness.screen.replyCell(10, 20)
  // reason: a NEGATIVE observation window — a late/busy settle must NOT arrive.
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(harness.graphics.canPaint(), true)
  assert.equal(harness.notifications(), settled, 'no readiness change, so no repaint request')
  assert.equal(paint(harness, image, 40)[0], dcs, 'the ready raster is unchanged')
})

test('invalidate() repaints the same occurrence without a second encode', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const image = harness.graphics.image(
    { pngBase64: await TWO_BAND_PNG(), widthPx: 40, heightPx: 40 },
    { maxWidthCells: 8, fallback: 'fallback' },
  )
  paint(harness, image, 40)
  await waitForRepaint(harness, 'the first encode')
  const first = paint(harness, image, 40)[0]!

  const originalEncode = SixelEncoder.prototype.encode
  let encodes = 0
  SixelEncoder.prototype.encode = function patched(this: SixelEncoder, request) {
    encodes += 1
    return originalEncode.call(this, request)
  }
  t.after(() => {
    SixelEncoder.prototype.encode = originalEncode
  })
  image.invalidate()
  assert.equal(paint(harness, image, 40)[0], first, 'the ready raster survives an invalidate')
  // reason: a NEGATIVE observation window — a late/busy settle must NOT arrive.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(encodes, 0, 'a repaint of the same facts must not re-encode')
})

test('dispose drops every raster, aborts the lane and refuses new work', async (t) => {
  const harness = await readyHarness(t)
  const image = harness.graphics.image(
    { pngBase64: await TWO_BAND_PNG(), widthPx: 40, heightPx: 40 },
    { maxWidthCells: 8, fallback: 'fallback' },
  )
  paint(harness, image, 40)
  await waitForRepaint(harness, 'the encode')
  const dcs = paint(harness, image, 40)[0]!
  assert.notEqual(harness.graphics.screen.footprint(dcs), undefined)

  harness.graphics.dispose()
  harness.graphics.dispose()
  assert.equal(harness.graphics.canPaint(), false)
  assert.equal(harness.graphics.screen.footprint(dcs), undefined, 'the trust table is emptied')
  assert.equal(paint(harness, image, 40)[0], 'fallback')
  assert.equal(image.paintedBodyAt?.(40), undefined)
  // reason: a NEGATIVE observation window — a late/busy settle must NOT arrive.
  await new Promise(resolve => setTimeout(resolve, 200))
})

test('a settle that lands after disposal registers nothing', async (t) => {
  const harness = await readyHarness(t, { rows: 24 })
  const notifications = harness.notifications()
  const png = await pngFromRgba(fill(600, 400, (x, y) => [x % 256, y % 256, 120, 255]), 600, 400)
  const image = harness.graphics.image({ pngBase64: png, widthPx: 600, heightPx: 400 }, { maxWidthCells: 40, fallback: 'fallback' })
  assert.equal(paint(harness, image, 40)[0], 'fallback')
  // Dispose while the encode is in flight.
  harness.graphics.dispose()
  // reason: a NEGATIVE observation window — a late/busy settle must NOT arrive.
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(paint(harness, image, 40)[0], 'fallback', 'a late result never revives a disposed occurrence')
  assert.equal(image.paintedBodyAt?.(40), undefined)
  assert.equal(harness.notifications(), notifications, 'a disposed owner requests no repaint')
})

/**
 * A BOUND test, not a correctness proof of the plan's capacity intent: it pins that
 * the registry refuses the over-budget request instead of evicting a record a live
 * component still renders. Whether off-screen occurrences SHOULD release their
 * records is the open capacity question recorded in the module doc (it needs a
 * component-visible invalidation channel the port does not have).
 */
test('the registry refuses a new raster instead of evicting a painted one', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const images: PixelBody[] = []
  for (let index = 0; index < SIXEL_REGISTRY_MAX_VARIANTS + 1; index += 1) {
    // Every occurrence is a DIFFERENT picture, so every raster is a distinct
    // retained payload: an identical source would legitimately share one.
    const png = await pngFromRgba(
      fill(40, 40, (x) => (x < 20 ? [255, 0, 0, 255] : [0, 0, index * 8, 255])),
      40,
      40,
    )
    images.push(harness.graphics.image({ pngBase64: png, widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, fallback: 'fallback' }))
  }
  // Every frame re-renders every mounted component; do the same here so a
  // settled encode is actually looked up again.
  await waitUntil(() => {
    paintFrame(harness, images, 40)
    return images.filter(image => image.paintedBodyAt?.(40) !== undefined).length >= SIXEL_REGISTRY_MAX_VARIANTS
  }, 'the registry to fill')
  // reason: a NEGATIVE observation window — a late/busy settle must NOT arrive.
  await new Promise(resolve => setTimeout(resolve, 300))
  const painted = paintFrame(harness, images, 40).map(frame => frame[0]!)
  const ready = painted.filter(line => harness.graphics.screen.footprint(line) !== undefined)
  assert.equal(ready.length, SIXEL_REGISTRY_MAX_VARIANTS, 'the cap is exactly the frozen variant budget')
  assert.equal(harness.graphics.screen.footprint(painted[0]!), undefined, 'the oldest contestant yields to the newest')
  assert.notEqual(harness.graphics.screen.footprint(painted[painted.length - 1]!), undefined, 'the newest keeps its pixels')
})

test('a live crop variant is never evicted to make room (RFL-003)', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const png = await pngFromRgba(fill(40, 60, (_x, y) => (y < 20 ? [255, 0, 0, 255] : y < 40 ? [0, 255, 0, 255] : [0, 0, 255, 255])), 40, 60)
  // Leave room for exactly TWO crop variants: the third one then has to evict.
  const fulls: PixelBody[] = []
  for (let index = 0; index < SIXEL_REGISTRY_MAX_VARIANTS - 2; index += 1) {
    // Both bands differ per occurrence, so two 1-row crops are DIFFERENT strings
    // (identical crops legitimately share one registry record).
    const distinct = await pngFromRgba(
      fill(40, 60, (_x, y) => (y < 20 ? [255, 0, index * 4, 255] : y < 40 ? [index * 4, 255, 0, 255] : [0, 0, 255, 255])),
      40,
      60,
    )
    fulls.push(harness.graphics.image({ pngBase64: distinct, widthPx: 40, heightPx: 60 }, { maxWidthCells: 8, maxHeightCells: 4, fallback: 'fallback' }))
  }
  // Every frame re-renders every mounted occurrence; a settled encode is only
  // looked up again by a render, so the poll renders them too.
  await waitUntil(() => {
    paintFrame(harness, fulls, 40)
    return fulls.every(image => image.paintedBodyAt?.(40) !== undefined)
  }, 'the registry to fill')

  /** Poll exactly like the layout does: the first call schedules, later ones read. */
  const cropUntilReady = async (line: string): Promise<string> => {
    let value: string | undefined
    await waitUntil(() => {
      value = harness.graphics.screen.crop(line, 1, 1)
      return value !== undefined
    }, 'a crop variant')
    return value!
  }

  const filled = paintFrame(harness, fulls, 40)
  const firstDcs = filled[0]![0]!
  const secondDcs = filled[1]![0]!
  assert.notEqual(harness.graphics.screen.footprint(firstDcs), undefined)
  const firstVariant = await cropUntilReady(firstDcs)
  const secondVariant = await cropUntilReady(secondDcs)
  assert.notEqual(firstVariant, secondVariant)

  // Both live crops are pinned: a third one has to evict, and a record the current
  // frame paints is NOT evictable — so it is refused instead of dropping one.
  const thirdDcs = filled[2]![0]!
  const beforeThird = harness.notifications()
  assert.equal(harness.graphics.screen.crop(thirdDcs, 1, 1), undefined)
  // The third crop must NOT settle, so there is no positive signal to await.
  // reason: a NEGATIVE observation window (the refusal is the absence of a repaint).
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(harness.graphics.screen.crop(firstDcs, 1, 1), firstVariant, 'the first live crop survives')
  assert.equal(harness.graphics.screen.crop(secondDcs, 1, 1), secondVariant, 'the second live crop survives')
  assert.notEqual(harness.graphics.screen.footprint(firstVariant), undefined, 'and it is still a trusted raster')
  assert.equal(harness.notifications(), beforeThird, 'a refused crop reports no settle')
  void png
})

test('a deterministically unpaintable request is not re-encoded every frame (RFL-006)', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  // A fully transparent picture: the codec paints nothing and the occurrence must
  // stay text WITHOUT re-tasking the lane on every repaint.
  const transparent = await pngFromRgba(fill(40, 40, () => [0, 0, 0, 0]), 40, 40)
  const image = harness.graphics.image({ pngBase64: transparent, widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, fallback: 'fallback' })

  const originalEncode = SixelEncoder.prototype.encode
  let encodes = 0
  SixelEncoder.prototype.encode = function patched(this: SixelEncoder, request) {
    encodes += 1
    return originalEncode.call(this, request)
  }
  t.after(() => {
    SixelEncoder.prototype.encode = originalEncode
  })

  paint(harness, image, 40)
  await waitUntil(() => encodes >= 1, 'the first encode')
  // Let the settle land, then repaint many times with no input at all. The settle
  // is the ABSENCE of a raster, so the window is the only observation bound.
  // reason: a NEGATIVE observation window before the repaint loop.
  await new Promise(resolve => setTimeout(resolve, 300))
  const settled = encodes
  for (let frame = 0; frame < 25; frame += 1) {
    image.invalidate()
    assert.equal(paint(harness, image, 40)[0], 'fallback', 'a transparent picture stays text')
  }
  // reason: a NEGATIVE observation window — a re-encode would appear DURING it.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(encodes, settled, 'the same unpaintable request is not re-sent on every frame')
})

test('an unadmittable crop is not re-encoded on every frame (RFL-006 crop branch)', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  // Sixteen pinned fulls: every crop admission is refused for lack of a slot.
  const fulls: PixelBody[] = []
  for (let index = 0; index < SIXEL_REGISTRY_MAX_VARIANTS; index += 1) {
    const distinct = await pngFromRgba(
      fill(40, 60, (_x, y) => (y < 20 ? [255, 0, index * 4, 255] : y < 40 ? [index * 4, 255, 0, 255] : [0, 0, 255, 255])),
      40,
      60,
    )
    fulls.push(harness.graphics.image({ pngBase64: distinct, widthPx: 40, heightPx: 60 }, { maxWidthCells: 8, maxHeightCells: 4, fallback: 'fallback' }))
  }
  await waitUntil(() => {
    paintFrame(harness, fulls, 40)
    return fulls.every(image => image.paintedBodyAt?.(40) !== undefined)
  }, 'the registry to fill')
  const line = paintFrame(harness, fulls, 40)[0]![0]!

  const originalEncode = SixelEncoder.prototype.encode
  let encodes = 0
  SixelEncoder.prototype.encode = function patched(this: SixelEncoder, request) {
    encodes += 1
    return originalEncode.call(this, request)
  }
  t.after(() => {
    SixelEncoder.prototype.encode = originalEncode
  })

  // The first request is scheduled and then refused by the budget.
  assert.equal(harness.graphics.screen.crop(line, 1, 1), undefined)
  await waitUntil(() => encodes >= 1, 'the first crop encode')
  // reason: a NEGATIVE observation window — the refusal has no positive signal.
  await new Promise(resolve => setTimeout(resolve, 300))
  const settled = encodes
  for (let frame = 0; frame < 20; frame += 1) {
    assert.equal(harness.graphics.screen.crop(line, 1, 1), undefined, 'the refused variant keeps painting nothing')
  }
  // reason: a NEGATIVE observation window — a retry would appear during it.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(encodes, settled, 'the refused crop is not re-sent until the trust table changes')
})

test('a crop variant shared by two occurrences survives one owner leaving (RFL-010)', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  // Two DIFFERENT pictures with an IDENTICAL first cell row: their 1-row crop
  // encodes to the same bytes, which is exactly the shared-record case.
  const top = (y: number): [number, number, number, number] => (y < 20 ? [255, 0, 0, 255] : [0, 0, 0, 255])
  const firstPng = await pngFromRgba(fill(40, 60, (_x, y) => (y < 20 ? [255, 0, 0, 255] : y < 40 ? [0, 255, 0, 255] : [0, 0, 255, 255])), 40, 60)
  const secondPng = await pngFromRgba(fill(40, 60, (_x, y) => (y < 20 ? [255, 0, 0, 255] : y < 40 ? [0, 0, 255, 255] : [0, 255, 0, 255])), 40, 60)
  void top
  const first = harness.graphics.image({ pngBase64: firstPng, widthPx: 40, heightPx: 60 }, { maxWidthCells: 8, maxHeightCells: 4, fallback: 'fallback' })
  const second = harness.graphics.image({ pngBase64: secondPng, widthPx: 40, heightPx: 60 }, { maxWidthCells: 8, maxHeightCells: 4, fallback: 'fallback' })
  await waitUntil(() => {
    paintFrame(harness, [first, second], 40)
    return first.paintedBodyAt?.(40) !== undefined && second.paintedBodyAt?.(40) !== undefined
  }, 'both full rasters')
  const sharedFrame = paintFrame(harness, [first, second], 40)
  const firstDcs = sharedFrame[0]![0]!
  const secondDcs = sharedFrame[1]![0]!
  assert.notEqual(firstDcs, secondDcs, 'the two pictures are different')

  const cropUntilReady = async (line: string): Promise<string> => {
    let value: string | undefined
    await waitUntil(() => {
      value = harness.graphics.screen.crop(line, 0, 1)
      return value !== undefined
    }, 'the first-row variant')
    return value!
  }
  const firstVariant = await cropUntilReady(firstDcs)
  const secondVariant = await cropUntilReady(secondDcs)
  assert.equal(firstVariant, secondVariant, 'identical visible rows share ONE registry record')
  assert.notEqual(harness.graphics.screen.footprint(firstVariant), undefined)

  // One owner leaves: the shared variant must stay registered for the other one.
  first.dispose?.()
  assert.equal(harness.graphics.screen.crop(secondDcs, 0, 1), secondVariant, 'the survivor still answers')
  assert.notEqual(
    harness.graphics.screen.footprint(secondVariant),
    undefined,
    'and the Screen still trusts that exact string',
  )
  // A crop OF a crop variant is refused: only a full raster has a source.
  assert.equal(harness.graphics.screen.crop(secondVariant, 0, 1), undefined)
})

test('a rejected encode settles the occurrence instead of leaving it pending (E2)', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const png = await TWO_BAND_PNG()

  const originalEncode = SixelEncoder.prototype.encode
  let encodes = 0
  SixelEncoder.prototype.encode = function patched() {
    encodes += 1
    return Promise.reject(new SixelEncodeBusyError(SIXEL_MAX_QUEUED_JOBS))
  }
  t.after(() => {
    SixelEncoder.prototype.encode = originalEncode
  })

  const image = harness.graphics.image({ pngBase64: png, widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, fallback: 'fallback' })
  // Frame 1 starts the encode; it rejects. Without settling the token every later
  // frame would believe the encode is still running.
  assert.equal(paint(harness, image, 40)[0], 'fallback')
  await waitUntil(() => encodes === 1, 'the first attempt')
  // reason: a NEGATIVE observation window — the retry is scheduled by the NEXT render.
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(paint(harness, image, 40)[0], 'fallback')
  await waitUntil(() => encodes === 2, 'a bounded retry after the failure')

  // After the attempt budget the occurrence stops re-tasking the single lane.
  for (let frame = 0; frame < 20; frame += 1) paint(harness, image, 40)
  await waitUntil(() => encodes === SIXEL_ENCODE_ATTEMPT_LIMIT, 'the attempt budget')
  for (let frame = 0; frame < 20; frame += 1) paint(harness, image, 40)
  // reason: a NEGATIVE observation window — a further retry would appear during it.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(encodes, SIXEL_ENCODE_ATTEMPT_LIMIT, 'a permanent failure stops re-tasking the lane')
})

test('a rejected crop variant settles its token and stops after the budget (E2)', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const png = await pngFromRgba(fill(40, 60, (_x, y) => (y < 20 ? [255, 0, 0, 255] : y < 40 ? [0, 255, 0, 255] : [0, 0, 255, 255])), 40, 60)
  const image = harness.graphics.image({ pngBase64: png, widthPx: 40, heightPx: 60 }, { maxWidthCells: 8, maxHeightCells: 4, fallback: 'fallback' })
  paint(harness, image, 40)
  await waitForRepaint(harness, 'the full encode')
  const full = paint(harness, image, 40)[0]!

  const originalEncode = SixelEncoder.prototype.encode
  let encodes = 0
  SixelEncoder.prototype.encode = function patched() {
    encodes += 1
    return Promise.reject(new SixelEncodeRejectedError('The encode request was aborted.'))
  }
  t.after(() => {
    SixelEncoder.prototype.encode = originalEncode
  })

  // The first crop request is scheduled and rejects: the token must settle, or
  // `crop()` would answer undefined for the rest of the session.
  assert.equal(harness.graphics.screen.crop(full, 1, 1), undefined)
  await waitUntil(() => encodes === 1, 'the first crop attempt')
  // reason: a NEGATIVE observation window — the next frame schedules the retry.
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(harness.graphics.screen.crop(full, 1, 1), undefined)
  await waitUntil(() => encodes >= 2, 'a bounded crop retry')
  for (let frame = 0; frame < 20; frame += 1) harness.graphics.screen.crop(full, 1, 1)
  // reason: a NEGATIVE observation window — a further retry would appear during it.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.ok(encodes <= 4, `the crop retry stays bounded, got ${encodes}`)
})

test('a same-width background change without an intermediate render never re-emits the old composite (E1)', async (t) => {
  const harness = await readyHarness(t, { background: { r: 0, g: 0, b: 255 } })
  t.after(() => harness.graphics.dispose())
  const png = await pngFromRgba(fill(40, 40, () => [255, 0, 0, 128]), 40, 40)
  const image = harness.graphics.image({ pngBase64: png, widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, fallback: 'fallback' })
  paint(harness, image, 40)
  await waitForRepaint(harness, 'the encode over the blue background')
  const overBlue = paint(harness, image, 40)[0]!
  assert.ok(!overBlue.includes('fallback'))

  // The terminal background changes and the NEW facts land BEFORE any frame is
  // painted: a width-only frame cache would replay the blue composite here.
  harness.screen.background = { r: 0, g: 255, b: 0 }
  harness.graphics.resample()
  await waitUntil(() => harness.graphics.canPaint(), 'the re-verified facts')
  const frame = paint(harness, image, 40)
  assert.equal(frame[0], 'fallback', 'the stale composite must not be re-emitted at the same width')
  await waitForRepaint(harness, 'the re-encode over the green background')
  const overGreen = paint(harness, image, 40)[0]!
  assert.notEqual(overGreen, overBlue)
  const [greenR, greenG] = pixelAt(decodeSixel(overGreen), 4, 4)
  assert.ok(greenG > 100 && greenR > 60, `composited over green, got ${greenR},${greenG}`)
})

test('the newest visible image paints even when sixteen records are already held (capacity starvation)', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const images: PixelBody[] = []
  for (let index = 0; index < SIXEL_REGISTRY_MAX_VARIANTS; index += 1) {
    const distinct = await pngFromRgba(fill(40, 40, (x) => (x < 20 ? [255, 0, index * 4, 255] : [0, 0, 255, 255])), 40, 40)
    images.push(harness.graphics.image({ pngBase64: distinct, widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, fallback: 'fallback' }))
  }
  await waitUntil(() => {
    paintFrame(harness, images, 40)
    return images.every(image => image.paintedBodyAt?.(40) !== undefined)
  }, 'the registry to fill')

  // A long transcript: the sixteen earlier images are off screen; only the new
  // one is demanded. Before the visibility contract this was permanently text
  // (the registry was pinned by mounted occurrences). Now the off-screen records
  // are released after the frame and the visible image encodes.
  const extra = await pngFromRgba(fill(40, 40, () => [10, 200, 10, 255]), 40, 40)
  const newest = harness.graphics.image({ pngBase64: extra, widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, fallback: 'fallback' })
  await waitUntil(() => {
    paintFrame(harness, [newest], 40)
    return newest.paintedBodyAt?.(40) !== undefined
  }, 'the newest visible image to paint')
  assert.notEqual(paintFrame(harness, [newest], 40)[0]![0], 'fallback', 'the newest visible image is pixels')
  assert.ok(images.every(image => image.paintedBodyAt?.(40) === undefined), 'the off-screen occurrences were released')

  // If all seventeen are REALLY on screen at once, the hard budget still holds:
  // the newest keeps its pixels and at least one older block settles into text.
  const all = [...images, newest]
  const frame = paintFrame(harness, all, 40)
  const painted = frame.filter(lines => harness.graphics.screen.footprint(lines[0] ?? '') !== undefined)
  assert.ok(painted.length <= SIXEL_REGISTRY_MAX_VARIANTS, `at most ${SIXEL_REGISTRY_MAX_VARIANTS} rasters, got ${painted.length}`)
  assert.notEqual(harness.graphics.screen.footprint(frame[frame.length - 1]![0]!), undefined, 'the newest visible image wins a contested slot')
})

test('a crop retry keeps its failure count across attempts and then stops (X1)', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const png = await pngFromRgba(fill(40, 60, (_x, y) => (y < 20 ? [255, 0, 0, 255] : y < 40 ? [0, 255, 0, 255] : [0, 0, 255, 255])), 40, 60)
  const image = harness.graphics.image({ pngBase64: png, widthPx: 40, heightPx: 60 }, { maxWidthCells: 8, maxHeightCells: 4, fallback: 'fallback' })
  paint(harness, image, 40)
  await waitForRepaint(harness, 'the full encode')
  const full = paint(harness, image, 40)[0]!

  const originalEncode = SixelEncoder.prototype.encode
  let encodes = 0
  SixelEncoder.prototype.encode = function patched() {
    encodes += 1
    return Promise.reject(new SixelEncodeRejectedError('The encode request was aborted.'))
  }
  t.after(() => {
    SixelEncoder.prototype.encode = originalEncode
  })

  // Every attempt fails. The retry path clears the failure record (releaseCrop), so
  // the count must be carried on the pending request or the budget never fills and
  // each frame re-tasks the single encoder lane forever.
  for (let attempt = 1; attempt <= SIXEL_ENCODE_ATTEMPT_LIMIT; attempt += 1) {
    assert.equal(harness.graphics.screen.crop(full, 1, 1), undefined, `attempt ${attempt} answers nothing`)
    await waitUntil(() => encodes === attempt, `attempt ${attempt} to reach the lane`)
    // reason: a bounded window for the failure to settle before the next request.
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  // The budget is spent: a further request is refused WITHOUT touching the lane.
  for (let frame = 0; frame < 5; frame += 1) harness.graphics.screen.crop(full, 1, 1)
  // reason: a NEGATIVE observation window — a further attempt would appear during it.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(encodes, SIXEL_ENCODE_ATTEMPT_LIMIT, 'the retry budget really fills, then stops')
})

test('an off-screen occurrence releases its crop record too (registry returns to baseline)', async (t) => {
  const harness = await readyHarness(t)
  t.after(() => harness.graphics.dispose())
  const png = await pngFromRgba(fill(40, 60, (_x, y) => (y < 20 ? [255, 0, 0, 255] : y < 40 ? [0, 255, 0, 255] : [0, 0, 255, 255])), 40, 60)
  const image = harness.graphics.image({ pngBase64: png, widthPx: 40, heightPx: 60 }, { maxWidthCells: 8, maxHeightCells: 4, fallback: 'fallback' })
  paint(harness, image, 40)
  await waitForRepaint(harness, 'the full encode')
  // A one-row crop of the second cell row: a distinct retained variant.
  const before = harness.notifications()
  paint(harness, image, 40, { top: 1, rows: 1 })
  await waitUntil(() => harness.notifications() > before, 'the crop variant')
  const cropDcs = paint(harness, image, 40, { top: 1, rows: 1 })[0]!
  assert.notEqual(harness.graphics.screen.footprint(cropDcs), undefined, 'the crop is retained while visible')
  // The occurrence leaves the frame: its full AND crop records must both be
  // unregistered, or repeated scroll round-trips refill the budget with phantoms.
  paintFrame(harness, [], 40)
  assert.equal(harness.graphics.screen.footprint(cropDcs), undefined, 'the crop record was released')
  // A fresh occurrence with a different source can still be admitted.
  const other = await pngFromRgba(fill(40, 40, () => [9, 9, 9, 255]), 40, 40)
  const next = harness.graphics.image({ pngBase64: other, widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, fallback: 'fallback' })
  await waitUntil(() => {
    paint(harness, next, 40)
    return next.paintedBodyAt?.(40) !== undefined
  }, 'a fresh occurrence after the release')
})

test('dispose clears the candidate registry too (no retained source bytes)', async (t) => {
  const harness = await readyHarness(t)
  const png = await TWO_BAND_PNG()
  const image = harness.graphics.image({ pngBase64: png, widthPx: 40, heightPx: 40 }, { maxWidthCells: 8, fallback: 'fallback' })
  const token = image.render(40)[0]!
  assert.notEqual(harness.graphics.screen.candidate(token), undefined, 'a bound occurrence is a candidate')
  harness.graphics.dispose()
  assert.equal(harness.graphics.screen.candidate(token), undefined, 'dispose drops the candidate table')
})

// ── Image-8 / I8-5: the Zellij-only raster normalizer hook ─────────────────

/** Build the SAME owner behind an admitted non-DA1 capability (Zellij). */
async function readyAdmissionHarness(
  t: test.TestContext,
  normalizeRaster?: (raster: import('../../src/client/media/sixel/types.ts').SixelRaster) => import('../../src/client/media/sixel/types.ts').SixelRaster | undefined,
): Promise<Harness & { normalized: () => number }> {
  const home = testLifecycle(t).tempDir('sixel-zellij-owner-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const terminal = new ScriptedSixelTerminal(120, 24)
  const screen = new ScriptedScreen()
  screen.background = { r: 0x28, g: 0x2c, b: 0x34 }
  let notifications = 0
  let normalizations = 0
  const capability = { verdict: 'admitted' as const, dispose: () => {} }
  const graphics = createSixelGraphicsWithAdmission(terminal, capability, () => {
    notifications += 1
  }, (raster) => {
    normalizations += 1
    return normalizeRaster === undefined ? raster : normalizeRaster(raster)
  })
  assert.notEqual(graphics, undefined)
  graphics!.observeScreen(screen, terminal.columns, terminal.rows)
  screen.replyCell(10, 20)
  await waitUntil(() => graphics!.canPaint(), 'the admitted owner facts')
  return {
    graphics: graphics!,
    terminal,
    screen,
    notifications: () => notifications,
    normalized: () => normalizations,
  }
}

test('the Zellij normalizer runs for full and crop variants before registry admission', async (t) => {
  const harness = await readyAdmissionHarness(t, (raster) => {
    // Keep the production transform but prove the hook sees both variants.
    return raster.sequence.includes('!') || raster.sequence.includes('-') ? raster : undefined
  })
  t.after(() => harness.graphics.dispose())
  const png = await pngFromRgba(
    fill(40, 40, (_x, y) => (y < 20 ? [0, 0, 0, 0] : [255, 0, 0, 255])),
    40,
    40,
  )
  const image = harness.graphics.image(
    { pngBase64: png, widthPx: 40, heightPx: 40 },
    { maxWidthCells: 8, maxHeightCells: 4, fallback: 'fallback' },
  )
  assert.equal(paint(harness, image, 40)[0], 'fallback')
  await waitUntil(() => harness.notifications() > 1, 'the full encode settle')
  const full = paint(harness, image, 40)[0]!
  assert.ok(full.startsWith('\x1bP0;1;q'), 'the full variant is one trusted DCS')
  assert.notEqual(harness.graphics.screen.footprint(full), undefined, 'the full variant is registered')
  const fullDecoded = decodeSixel(full)
  assert.ok(fullDecoded.width > 0)

  const beforeCrop = harness.normalized()
  const repaint = harness.notifications()
  assert.equal(paint(harness, image, 40, { top: 1, rows: 2 })[0], 'fallback')
  await waitUntil(() => harness.notifications() > repaint, 'the crop encode settle')
  const crop = paint(harness, image, 40, { top: 1, rows: 2 })[0]!
  assert.ok(crop.startsWith('\x1bP0;1;q'), 'the crop variant is one trusted DCS')
  assert.notEqual(harness.graphics.screen.footprint(crop), undefined, 'the crop variant is registered')
  assert.ok(harness.normalized() >= beforeCrop + 1, 'the hook ran for the full and crop encodes')
})
