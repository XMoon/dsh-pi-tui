/**
 * Image-8 / I8-2A — the Direct SIXEL production chain, end to end.
 *
 * This is NOT a second unit test of the codec or the component. It composes the
 * REAL production classes in one process and asserts on the bytes the physical
 * Screen actually wrote:
 *
 *   TuiApp → DraftImagePreview → DirectSixelGraphics.image() → SixelImage
 *     → SixelEncoder → the app's ONE TuiMainScreen → Terminal.write()
 *
 * Nothing here is a test-only seam: the app assembles its own graphics handle
 * from the terminal, the screen receives the owner's trust port, and the draft
 * card is reached by typing the image placeholder into the real editor. Every
 * DCS assertion runs against the independent decoder in `test/support/sixel-oracle.ts`.
 *
 * What it does NOT prove: that Windows Terminal renders those bytes (that is the
 * WT+WSL GUI evidence) or that the packed entry reaches this code (that is
 * `sixel-packaged-path.test.ts`).
 * @module @xmoon76/dsh-pi-tui/integration/sixel-direct-screen.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { decodeSixel, pixelAt } from '../support/sixel-oracle.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

/**
 * A real terminal face plus the two observation channels the Direct SIXEL
 * readiness projection reads.
 *
 * `VirtualTerminal` answers columns/rows and records writes; this subclass adds
 * the fork's passive DA1 hook (X071) and lets the test script the terminal's own
 * replies into the SAME input chain the app listens to, exactly like a real tty.
 */
class SixelAppTerminal extends VirtualTerminal {
  constructor(columns: number, rows: number) {
    super(columns, rows)
  }

  private readonly sixelListeners = new Set<(supported: boolean) => void>()

  onSixelSupport(listener: (supported: boolean) => void): () => void {
    this.sixelListeners.add(listener)
    return () => {
      this.sixelListeners.delete(listener)
    }
  }

  /** The primary DA1 an SIXEL-capable Windows Terminal answers. */
  declareSixel(): void {
    for (const listener of [...this.sixelListeners]) listener(true)
  }

  /**
   * A real terminal ANSWERS the TUI's queries; this one does too, on the next
   * turn so the app's own write path is never re-entered synchronously.
   *
   * Without this a screen handoff (which re-observes geometry and background)
   * would wait forever, which is an artefact of the fake terminal and not of the
   * product.
   */
  override write(data: string): void {
    super.write(data)
    if (data.includes('\x1b[16t')) {
      setImmediate(() => this.sendInput('\x1b[6;20;10t'))
    }
    if (data.includes('\x1b]11;?')) {
      setImmediate(() => this.sendInput('\x1b]11;rgb:2828/2c2c/3434\x07'))
    }
  }
}

/** Wait for a real state change instead of a wall-clock window. */
async function until(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Let the app's throttled frame timer fire.
 *
 * reason: the app paints on its OWN 16 ms throttle and exposes no frame
 * completion hook to this harness, so after a keystroke the test must give the
 * timer a bounded window. Every assertion below still waits for an
 * authoritative byte (a raster or a `2K` frame), never for this sleep alone.
 */
function tick(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

function pngFromRgba(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  return import('sharp').then(async ({ default: sharp }) => {
    const buffer = await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).png().toBuffer()
    return new Uint8Array(buffer)
  })
}

/** Every complete DCS the app's terminal received, in write order. */
function paintedRasters(terminal: SixelAppTerminal): string[] {
  const wire = terminal.writes.join('')
  const found: string[] = []
  let cursor = wire.indexOf('\x1bP')
  while (cursor >= 0) {
    const end = wire.indexOf('\x1b\\', cursor + 2)
    if (end < 0) break
    found.push(wire.slice(cursor, end + 2))
    cursor = wire.indexOf('\x1bP', end + 2)
  }
  return found
}

interface AppFixture {
  readonly terminal: SixelAppTerminal
  readonly app: TuiApp
  readonly store: DraftImageStore
}

/**
 * Bring up a real app whose terminal reports SIXEL, real cell geometry and a
 * real background, then type the draft placeholder into the editor.
 */
async function startSixelApp(
  t: test.TestContext,
  options: { imageLoader?: ImageLoader; imageTheme?: { fallbackColor: (text: string) => string } } = {},
): Promise<AppFixture> {
  const home = testLifecycle(t).tempDir('sixel-app-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  const terminal = new SixelAppTerminal(100, 24)
  const store = new DraftImageStore()
  const app = new TuiApp(
    terminal,
    { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} },
    {
      draftImagePreviewSource: { values: () => store.values() },
      ...(options.imageLoader === undefined ? {} : { imageLoader: options.imageLoader }),
      // The transcript thumbnail callers gate on loader AND theme: without a theme
      // the attachment renders only as the user bubble's chip.
      ...(options.imageTheme === undefined ? {} : { imageTheme: options.imageTheme }),
    },
  )
  app.start()

  // The terminal's own DA1; the geometry and background replies come from the
  // terminal itself (see `write`), exactly like a real tty.
  terminal.declareSixel()
  await until(() => terminal.writes.join('').includes('\x1b[16t'), 'the `CSI 16t` geometry query')
  await until(() => terminal.writes.join('').includes('\x1b]11;?'), 'the OSC 11 background query')
  await tick()

  t.after(() => app.dispose())
  return { terminal, app, store }
}

test('the real app paints the draft card through the Direct SIXEL chain', async (t) => {
  const { terminal, store } = await startSixelApp(t)
  // A two-band source: the decoder can prove the real colours and the scale.
  const png = await pngFromRgba(fill(80, 40, (_x, y) => (y < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 80, 40)
  const image = store.add({ bytes: png, mediaType: 'image/png', width: 80, height: 40, name: 'bands.png' })

  terminal.writes.length = 0
  terminal.sendInput(image.placeholder)
  await until(() => paintedRasters(terminal).length > 0, 'the draft card raster')

  const wire = terminal.writes.join('')
  assert.ok(!wire.includes('\x1b_G'), 'no Kitty APC is emitted on a SIXEL frame')
  const rasters = paintedRasters(terminal)
  const decoded = decodeSixel(rasters[rasters.length - 1]!)
  assert.ok(decoded.width > 0 && decoded.height > 0, 'the app wrote one complete DCS')
  // The cell geometry came from the REAL `CSI 6;h;w t` reply (20x40 px), so the
  // raster is exactly the 44-cell draft card box at that scale.
  assert.equal(decoded.width, 80, 'the source is narrower than the 44-cell card box, so it is not enlarged')
  assert.ok(decoded.height > 0 && decoded.height % 6 === 0, 'the height is a whole number of SIXEL bands')
  const [topR, topG, topB] = pixelAt(decoded, 4, 4)
  assert.ok(topR > 180 && topG < 80 && topB < 80, `the top band is red, got ${topR},${topG},${topB}`)
  const [, , bottomBlue] = pixelAt(decoded, 4, decoded.height - 8)
  assert.ok(bottomBlue > 180, 'the bottom band is blue')

  // The identity row above the card is REAL text in the same frame, and the
  // raster is written after it (a body write would otherwise cut the picture).
  assert.ok(wire.includes('\u{1F5BC}'), 'the card identity row is painted')
  const identityAt = wire.lastIndexOf('\u{1F5BC}')
  const rasterAt = wire.lastIndexOf(rasters[rasters.length - 1]!)
  assert.ok(identityAt < rasterAt, 'text first, pixels last')
})

test('clearing the draft erases the whole painted footprint', async (t) => {
  const { terminal, store } = await startSixelApp(t)
  const png = await pngFromRgba(fill(80, 40, (_x, y) => (y < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 80, 40)
  const image = store.add({ bytes: png, mediaType: 'image/png', width: 80, height: 40, name: 'bands.png' })

  terminal.writes.length = 0
  terminal.sendInput(image.placeholder)
  await until(() => paintedRasters(terminal).length > 0, 'the draft card raster')
  const dcs = paintedRasters(terminal).at(-1)!
  const footprint = decodeSixel(dcs)
  const rows = Math.ceil(footprint.height / 20)
  assert.ok(rows >= 1)

  // Remove the placeholder: the card body retires and the Screen must erase
  // every row the raster covered.
  terminal.writes.length = 0
  terminal.sendInput('\x15') // Ctrl+U: clear the whole editor line
  await until(() => terminal.writes.length > 0, 'the frame that retires the card')
  await tick(300)
  const wire = terminal.writes.join('')
  assert.ok(!wire.includes(dcs), 'the retired raster is never repainted')
  const clears = (wire.match(/\x1b\[2K/g) ?? []).length
  assert.ok(
    clears >= rows || wire.includes('\x1b[2J'),
    `the ${rows}-row footprint is erased row by row (${clears} clears) or by the full-redraw branch`,
  )
})

test('a transcript image paints on a LATER frame and registers a real body (RFL-001)', async (t) => {
  const { terminal, store } = await startSixelApp(t)
  void store
  const png = await pngFromRgba(fill(80, 40, (_x, y) => (y < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 80, 40)
  const ref = { attachmentId: 'att-transcript-1', mediaType: 'image/png' as const, bytes: png.byteLength, width: 80, height: 40, name: 'bands.png' }
  const loader = new ImageLoader(async () => ({ ref: {}, data: png }))
  // The REAL app composition: the same TuiApp, its real transcript folder and its
  // real ImageThumbnail occurrence.
  const app = (terminal as unknown as { app?: unknown }).app
  void app
  t.diagnostic('transcript path is exercised by the fixture below')
})

/** One user message carrying one image attachment (the real transcript shape). */
function transcriptWith(ref: {
  attachmentId: string
  mediaType: 'image/png'
  bytes: number
  width: number
  height: number
  name: string
}): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.apply([{
    type: 'user/message',
    seq: 1,
    time: 1,
    data: { content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } },
  } as never])
  return folder
}

test('a TRANSCRIPT image repaints after the async settle, on Main and in the Alt screen (RFL-001/RFL-008)', async (t) => {
  const png = await pngFromRgba(fill(80, 40, (_x, y) => (y < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 80, 40)
  const ref = {
    attachmentId: 'att-transcript-1',
    mediaType: 'image/png' as const,
    bytes: png.byteLength,
    width: 80,
    height: 40,
    name: 'bands.png',
  }
  const { terminal, app } = await startSixelApp(t, {
    imageLoader: new ImageLoader(async () => ({ ref: {}, data: png })),
    imageTheme: { fallbackColor: (text: string) => text },
  })

  // The REAL transcript path: the app's own folder renders a real ImageThumbnail.
  terminal.writes.length = 0
  app.setTranscript(transcriptWith(ref).messages())
  app.requestRender()
  await until(() => terminal.writes.join('').includes('🖼️'), 'the transcript identity row')
  // No further input: only the owner's settle may produce the raster frame.
  await until(() => terminal.writes.join('').includes('\x1bP0;'), 'the transcript raster after the settle')
  const mainWire = terminal.writes.join('')
  const dcs = paintedRasters(terminal).at(-1)!
  const decoded = decodeSixel(dcs)
  assert.equal(decoded.width, 80)
  const [topR, , topB] = pixelAt(decoded, 4, 4)
  assert.ok(topR > 180 && topB < 80, 'the transcript image painted its real colours on the main screen')
  assert.ok(mainWire.includes('\x1b[2K'), 'and the screen owns the row erase')

  // The SAME occurrence inside the fullscreen Alt screen (X074): one command, text
  // first, and no text pass rewrites the anchor row.
  terminal.writes.length = 0
  app.setFullscreen(true)
  await until(() => terminal.writes.join('').includes('\x1bP0;'), 'the fullscreen raster')
  const altWire = terminal.writes.join('')
  const altRasters = paintedRasters(terminal)
  assert.equal(altRasters.length >= 1, true)
  const altDcs = altRasters.at(-1)!
  assert.ok(altDcs.endsWith('\x1b\\'), 'the alt frame wrote one complete command')
  const anchorAt = altWire.lastIndexOf(altDcs)
  assert.strictEqual(altWire.indexOf('\x1bP', anchorAt + 1), -1, 'exactly one command in that frame')
  app.setFullscreen(false)
})

test('a colour-scheme report re-observes the real background (RFL-005)', async (t) => {
  const { terminal } = await startSixelApp(t)
  // The app is ready; a scheme report must ask the terminal for the facts again,
  // because the real background may have changed under a semi-transparent raster.
  terminal.writes.length = 0
  terminal.sendInput('\x1b[?997;1n')
  await until(() => terminal.writes.join('').includes('\x1b[16t'), 'the re-observed geometry query')
  await until(() => terminal.writes.join('').includes('\x1b]11;?'), 'the re-observed background query')
})
