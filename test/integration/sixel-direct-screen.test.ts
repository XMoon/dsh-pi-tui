/**
 * Image-8 / I8-2A + I8-2B — the Direct SIXEL production chain, end to end.
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
 * I8-2B adds the four product journeys: `/view-image` LIST/Viewer, the
 * transcript direct Viewer, the SVG tool/Assistant thumbnail and the SVG
 * Viewer — all through the SAME production `TuiApp`, Client loaders/admission,
 * Direct owner, Screen trust port and Terminal bytes.
 *
 * What it does NOT prove: that Windows Terminal renders those bytes (that is the
 * WT+WSL GUI evidence) or that the packed entry reaches this code (that is
 * `sixel-packaged-path.test.ts`).
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - real TuiApp creates its OWN DirectSixelGraphics and mounts its Screen/Workspace
 * - capability DA1, CSI 16t cell size, OSC11 background observations via terminal input
 * - real ImageLoader + same scoped JPEG/WebP derivative
 * - real admitSvg + SvgRasterLoader(rasterizeSvg) (on Linux)
 * - same Owner -> Screen trust/materialization -> Terminal.write -> independent oracle
 * - real TuiApp published visual/tool and workspace navigation handlers
 * TEST STAND-INS / SUBSTITUTIONS
 * - SixelAppTerminal/VirtualTerminal records physical bytes; synthetic authorized source fixtures
 * - user key/pointer injection (not OS mouse)
 * DELIBERATELY ABSENT
 * - physical Windows Terminal font/DPI/window composite
 * - tmux/Zellij wire topology
 * - full DSH Host/Remote Session transport
 * @module @xmoon76/dsh-pi-tui/integration/sixel-direct-screen.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import type { TuiAppEvents } from '../../src/tui-app.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import { rasterizeSvg } from '../../src/client/media/svg/rasterize.ts'
import { clearAssistantVisualPresentation, setAssistantVisualPresentation, type VisualPresentationKey } from '../../src/domain/visual/presentation.ts'
import { SVG_TOOL_NAME } from '../../src/domain/visual/tools.ts'
import { svgFactFromArgs, svgHumanText } from '../../src/domain/visual/svg.ts'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder, type TranscriptMessage } from '../../src/transcript.ts'
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

  /** Drive one REAL terminal size change through `VirtualTerminal.resize()`
   *  (which updates both dimensions, resizes the screen and fires the app's
   *  own resize callback exactly once — never a second manual callback). */
  emitResize(columns: number, rows: number = this.rows): void {
    this.resize(columns, rows)
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

/**
 * Wait out the fork's DOUBLE_CLICK_INTERVAL_MS window before the next pointer
 * gesture at the same cell. This is the surface's own contract (a second
 * same-cell press within 500 ms is a word-selection double click and withholds
 * the release callback), not a blind UI sleep.
 */
function settlePointerWindow(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 600))
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
  options: {
    imageLoader?: ImageLoader
    imageTheme?: { fallbackColor: (text: string) => string }
    openExternalEditor?: (draft: string) => Promise<string>
    svgLoader?: SvgRasterLoader
    copySelection?: (text: string) => Promise<boolean>
    /** A denied topology issues no readiness query: let the test skip the waits. */
    skipSixelReadiness?: boolean
  } = {},
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
    {
      onSubmit: () => {},
      onExit: () => {},
      onCancel: () => {},
      // The app routes every owned task (clipboard copy, external editor)
      // through this entry in production; the fixture lets the task settle.
      runOwned: (_label: string, task: () => unknown) => {
        void Promise.resolve(task()).catch(() => {})
      },
      // The external-editor capability is a BOUND pair: the action flow routes
      // through the owned-task entry, so a test that stubs the editor must stub
      // BOTH (the constructor fails fast otherwise).
      ...(options.openExternalEditor === undefined
        ? {}
        : {
            openExternalEditor: options.openExternalEditor,
          }),
    } as TuiAppEvents,
    {
      draftImagePreviewSource: { values: () => store.values() },
      ...(options.imageLoader === undefined ? {} : { imageLoader: options.imageLoader }),
      ...(options.svgLoader === undefined ? {} : { svgRasterLoader: options.svgLoader }),
      ...(options.copySelection === undefined ? {} : { copySelection: options.copySelection }),
      // The transcript thumbnail callers gate on loader AND theme: without a theme
      // the attachment renders only as the user bubble's chip.
      ...(options.imageTheme === undefined ? {} : { imageTheme: options.imageTheme }),
    },
  )
  app.start()

  // The terminal's own DA1; the geometry and background replies come from the
  // terminal itself (see `write`), exactly like a real tty.
  if (options.skipSixelReadiness !== true) {
    terminal.declareSixel()
    await until(() => terminal.writes.join('').includes('\x1b[16t'), 'the `CSI 16t` geometry query')
    await until(() => terminal.writes.join('').includes('\x1b]11;?'), 'the OSC 11 background query')
  }
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

interface TranscriptImageRef {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name: string
}

/** One user message per ref, in the given transcript order. */
function transcriptWithMany(refs: readonly TranscriptImageRef[]): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.apply(refs.map((ref, index) => ({
    type: 'user/message',
    seq: index + 1,
    time: index + 1,
    data: { content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } },
  })) as never)
  return folder
}

/** Flush the VirtualTerminal's own write queue, then read what the user sees. */
async function viewportOf(terminal: SixelAppTerminal): Promise<string> {
  await terminal.flush()
  return terminal.getViewport().join('\n')
}

/** Strip SGR so assertions compare painted text, not palette bytes. */
function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/** 1-based row of the first line containing the needle, or -1. */
function rowOf(text: string, needle: string): number {
  const index = text.split('\n').findIndex(line => line.includes(needle))
  return index === -1 ? -1 : index + 1
}

/** Wait for the next complete raster and return it. */
async function nextRaster(terminal: SixelAppTerminal, before: number, label: string): Promise<string> {
  await until(() => paintedRasters(terminal).length > before, label)
  return paintedRasters(terminal).at(-1)!
}

/** Wait until the flushed viewport no longer paints the needle. */
async function waitViewportGone(terminal: SixelAppTerminal, needle: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const view = await viewportOf(terminal)
    if (!view.includes(needle)) return
    await tick()
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** Wait until the flushed viewport paints the needle and return that text. */
async function waitViewport(terminal: SixelAppTerminal, needle: string, label: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const view = await viewportOf(terminal)
    if (view.includes(needle)) return view
    await tick()
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** One Assistant answer with one published SVG (the real sidecar path). */
function assistantSvgVisual(svg: string, title = 'Service topology', description = 'Gateway -> App'): {
  readonly folder: TranscriptFolder
  readonly assistant: TranscriptMessage & { kind: 'assistant' }
  readonly publication: PublishedVisual
} {
  const fact = svgFactFromArgs({ title, description, svg })
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } } as unknown as SessionEvent,
    {
      type: 'assistant/message',
      seq: 1,
      time: 2,
      data: {
        turn: 0,
        step: 0,
        message: {
          id: MessageId('sixel-assistant-svg'),
          role: 'assistant',
          content: [{ type: 'text', text: 'Before.\n\n[dsh-visual-sv1_' + 'a'.repeat(20) + ']: <#>\n\nAfter.' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    } as unknown as SessionEvent,
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 0, reason: { kind: 'completed' } } } as unknown as SessionEvent,
  ]
  folder.apply(events)
  const assistant = folder.messages().find(
    (message): message is TranscriptMessage & { kind: 'assistant' } => message.kind === 'assistant',
  )!
  const ref = `sv1_${'a'.repeat(20)}`
  const publication: PublishedVisual = {
    ref,
    turn: 0,
    step: 1,
    stepStartSeq: 5,
    callSeq: 6,
    resultSeq: 7,
    callId: 'present-svg',
    source: {
      ref,
      type: 'svg',
      title: fact.title,
      turn: 0,
      step: 0,
      stepStartSeq: 1,
      callSeq: 2,
      resultSeq: 3,
      callId: 'svg-source',
      chart: undefined,
      svg: fact,
      svgSource: svg,
      svgAdmissionWidth: 64,
    },
  }
  const key: VisualPresentationKey = {
    subjectKind: 'main',
    subjectId: 'session',
    sourceIdentity: {},
    session: {},
    sessionId: 'session',
    seq: 10,
    turn: 0,
    step: 1,
    text: '',
    content: undefined,
    assistantRevision: 0,
  }
  setAssistantVisualPresentation(assistant, key, [publication])
  return { folder, assistant, publication }
}

/** The real JPEG/WebP fixtures the transcript tests already own. */
const SAMPLE_JPEG = readFileSync(new URL('../fixtures/images/transcript-sample.jpg', import.meta.url))
const SAMPLE_WEBP = readFileSync(new URL('../fixtures/images/transcript-sample.webp', import.meta.url))

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
  // Exiting fullscreen replays the stopped alt document into the main screen: the
  // image's safe text, never the internal candidate marker.
  terminal.writes.length = 0
  app.setFullscreen(false)
  await tick(200)
  assert.ok(!terminal.writes.join('').includes('SIXC'), 'no candidate marker reaches Terminal.write')
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

test('a workspace lease re-binds the owner, and closing it re-certifies the return screen (RFL-011)', async (t) => {
  const png = await pngFromRgba(fill(80, 40, (_x, y) => (y < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 80, 40)
  const ref = {
    attachmentId: 'att-lease-1',
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
  app.setTranscript(transcriptWith(ref).messages())
  app.requestRender()
  await until(() => paintedRasters(terminal).length > 0, 'the transcript raster before the lease')

  // A real Settings lease: its screen owns the terminal for the whole lease.
  terminal.writes.length = 0
  const handle = app.openSettingsWorkspace(
    { readSnapshot: () => ({ configReadiness: 'ready' as const, rows: [], capturedAt: 0 }) },
    { aboutVersionFacts: { tui: 'test-bundle', dsh: undefined } },
  )
  await until(() => terminal.writes.join('').includes('\x1b[16t'), 'the lease screen to be re-observed')

  // A scheme report WHILE the workspace owns the terminal must sample the LEASE
  // screen, not the stopped return screen.
  terminal.writes.length = 0
  terminal.sendInput('\x1b[?997;1n')
  await until(() => terminal.writes.join('').includes('\x1b[16t'), 'the leased screen to re-observe on a scheme report')

  // Closing the lease restores the return screen: it must be re-observed and the
  // transcript raster must come back without any other input.
  terminal.writes.length = 0
  handle.close()
  await until(() => terminal.writes.join('').includes('\x1b[16t'), 'the return screen to be re-certified')
  await until(
    () => paintedRasters(terminal).some(dcs => dcs.includes('"1;1;80;')),
    'the transcript raster to return on the restored screen',
  )
})

test('returning from the external editor re-observes the facts and repaints (RFL-015)', async (t) => {
  const png = await pngFromRgba(fill(80, 40, (_x, y) => (y < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 80, 40)
  const ref = {
    attachmentId: 'att-editor-1',
    mediaType: 'image/png' as const,
    bytes: png.byteLength,
    width: 80,
    height: 40,
    name: 'bands.png',
  }
  let resizedDuringSuspend = false
  const { terminal, app } = await startSixelApp(t, {
    imageLoader: new ImageLoader(async () => ({ ref: {}, data: png })),
    imageTheme: { fallbackColor: (text: string) => text },
    // While $EDITOR owns the tty the terminal resizes: the resize hook observes
    // the STOPPED return screen, which invalidates the verified facts.
    openExternalEditor: async (draft: string) => {
      terminal.emitResize(90)
      resizedDuringSuspend = true
      // A bounded window so the resize hook's queries really time out while the
      // editor owns the tty (the contract under test is the later recovery).
      // reason: a NEGATIVE observation window (the failure is the absence of facts).
      await new Promise(resolve => setTimeout(resolve, 150))
      return draft
    },
  })
  app.setTranscript(transcriptWith(ref).messages())
  app.requestRender()
  await until(() => paintedRasters(terminal).length > 0, 'the raster before the editor round trip')

  terminal.writes.length = 0
  await app.launchExternalEditor()
  assert.equal(resizedDuringSuspend, true, 'the terminal really resized while the editor owned it')
  // The resume must re-bind and re-sample: a fresh geometry query and then the
  // raster again, with no other input.
  await until(() => terminal.writes.join('').includes('\x1b[16t'), 'the resume re-observation')
  await until(() => paintedRasters(terminal).length > 0, 'the raster after the resume')
})

test('24 distinct transcript images: the newest visible paints, and scrolling back re-encodes the first (B4 residency)', async (t) => {
  // 24 DISTINCT sources (a unique top-band tint each), so no two share a raster.
  const pngs: Uint8Array[] = []
  for (let index = 0; index < 24; index += 1) {
    pngs.push(
      await pngFromRgba(
        fill(80, 40, (x, y) => (y < 20 ? [255, (index * 10) % 255, x % 2 === 0 ? 0 : 8, 255] : [0, 0, 255, 255])),
        80,
        40,
      ),
    )
  }
  const refs = pngs.map((png, index) => ({
    attachmentId: `att-many-${index}`,
    mediaType: 'image/png' as const,
    bytes: png.byteLength,
    width: 80,
    height: 40,
    name: `many-${index}.png`,
  }))
  const { terminal, app } = await startSixelApp(t, {
    imageLoader: new ImageLoader(async (ref) => {
      const index = Number(String((ref as { attachmentId?: string }).attachmentId ?? '').split('-').at(-1))
      return { ref: {}, data: pngs[index]! }
    }),
    imageTheme: { fallbackColor: (text: string) => text },
  })
  const folder = new TranscriptFolder()
  folder.apply(
    refs.map((ref, index) => ({
      type: 'user/message',
      seq: index + 1,
      time: index + 1,
      data: { content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } },
    })) as never,
  )
  terminal.writes.length = 0
  app.setTranscript(folder.messages())
  app.requestRender()
  await until(() => paintedRasters(terminal).length > 0, 'a raster on the main screen')

  /** The decoded top-band green channel of the LAST raster, uniquely identifying the source. */
  const lastTopGreen = (): number => {
    const dcs = paintedRasters(terminal).at(-1)!
    const decoded = decodeSixel(dcs)
    return pixelAt(decoded, 4, 4)[1]
  }
  // The newest message is in the main screen's visible tail: it is pixels, and it
  // is the 24th source (green = 230).
  assert.equal(lastTopGreen(), (23 * 10) % 255, 'the newest visible image is the one painted')

  // Fullscreen Alt: the same transcript, same bottom anchor.
  terminal.writes.length = 0
  app.setFullscreen(true)
  await until(() => paintedRasters(terminal).length > 0, 'a raster in the fullscreen transcript')
  const altFirst = paintedRasters(terminal).at(-1)!
  assert.equal(pixelAt(decodeSixel(altFirst), 4, 4)[1], (23 * 10) % 255, 'the alt bottom anchor is the newest image')

  // Scroll to the TOP: the FIRST image becomes visible. Its sixteen-slot record
  // was released while it was off screen, so this must be a fresh encode of the
  // first source (green = 0), not a fallback.
  terminal.writes.length = 0
  app.scrollToTop()
  await until(
    () => paintedRasters(terminal).some(dcs => pixelAt(decodeSixel(dcs), 4, 4)[1] <= 10),
    'an early image to re-encode after scrolling back',
  )
  const recovered = paintedRasters(terminal).filter(dcs => pixelAt(decodeSixel(dcs), 4, 4)[1] <= 10)
  assert.ok(recovered.length > 0, 'the top window re-encoded one of the first sources (not a fallback)')

  // Back to the bottom: the newest image paints again.
  terminal.writes.length = 0
  app.scrollToBottom()
  await until(() => {
    const dcs = paintedRasters(terminal).at(-1)
    return dcs !== undefined && pixelAt(decodeSixel(dcs), 4, 4)[1] === (23 * 10) % 255
  }, 'the newest image to return after scrolling back down')
})

// ── Image-8 / I8-2B: the four Direct SIXEL product journeys ───────────────

test('E2-01: /view-image LIST→Viewer→Esc back→same list→Esc close restores the main screen', async (t) => {
  const png = await pngFromRgba(fill(80, 40, (_x, y) => (y < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 80, 40)
  const bytesById = new Map<string, Uint8Array>([
    ['att-e2-01-png', png],
    ['att-e2-01-jpeg', SAMPLE_JPEG],
    ['att-e2-01-webp', SAMPLE_WEBP],
  ])
  const loader = new ImageLoader(async (ref) => ({ ref: {}, data: bytesById.get(ref.attachmentId)! }))
  const { terminal, app } = await startSixelApp(t, {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text: string) => text },
  })
  const refs: TranscriptImageRef[] = [
    { attachmentId: 'att-e2-01-png', mediaType: 'image/png', bytes: png.byteLength, width: 80, height: 40, name: 'bands.png' },
    { attachmentId: 'att-e2-01-jpeg', mediaType: 'image/jpeg', bytes: SAMPLE_JPEG.byteLength, width: 120, height: 80, name: 'photo.jpg' },
    { attachmentId: 'att-e2-01-webp', mediaType: 'image/webp', bytes: SAMPLE_WEBP.byteLength, width: 120, height: 80, name: 'shot.webp' },
  ]
  app.setTranscript(transcriptWithMany(refs).messages())
  app.requestRender()
  await waitViewport(terminal, '🖼️', 'the mounted transcript image row')

  terminal.writes.length = 0
  app.openTranscriptImagePicker()
  const listed = await waitViewport(terminal, 'Images · current transcript', 'the leased image list')
  assert.ok(listed.includes('#1 · bands.png · 80×40 · image/png'), listed)
  assert.ok(listed.includes('#2 · photo.jpg · 120×80 · image/jpeg'), listed)
  assert.ok(listed.includes('#3 · shot.webp · 120×80 · image/webp'), listed)

  // Enter opens the SAME lease's Viewer (no second physical screen owner).
  const beforeViewer = paintedRasters(terminal).length
  terminal.sendInput('\r')
  const dcs = await nextRaster(terminal, beforeViewer, 'the viewer raster through the Direct SIXEL chain')
  const decoded = decodeSixel(dcs)
  assert.equal(decoded.width, 80, 'the Viewer paints the source width, not an enlarged variant')
  assert.ok(decoded.height > 0 && decoded.height % 6 === 0, 'the Viewer raster is a complete band-aligned image')
  const [topR, topG, topB] = pixelAt(decoded, 4, 4)
  assert.ok(topR > 180 && topG < 80 && topB < 80, `the PNG top band is really red: ${topR},${topG},${topB}`)
  const [, , bottomBlue] = pixelAt(decoded, 4, decoded.height - 8)
  assert.ok(bottomBlue > 180, 'the PNG bottom band is really blue')
  assert.ok(!terminal.writes.join('').includes('\x1b_G'), 'no Kitty APC on the SIXEL Viewer')
  const viewer = await waitViewport(terminal, 'Image · bands.png', 'the Viewer identity row')
  assert.ok(viewer.includes('80×40 · image/png'), `the ORIGINAL metadata is painted:\n${viewer}`)
  assert.ok(stripSgr(viewer).includes('Esc back'), 'the stacked Viewer advertises Esc back')

  // Esc #1: back to the SAME list, selection preserved.
  terminal.sendInput('\x1b')
  const restored = await waitViewport(terminal, 'Images · current transcript', 'the list after Esc back')
  assert.ok(restored.includes('> #1 · bands.png'), `the selection is preserved:\n${restored}`)
  assert.ok(!restored.includes('Image · bands.png'), 'the Viewer closed')
  // Esc #2: close the workspace and restore the main screen with no stale raster.
  terminal.writes.length = 0
  terminal.sendInput('\x1b')
  const closed = await waitViewport(terminal, '🖼️', 'the restored main screen')
  assert.ok(!closed.includes('Images · current transcript'), 'the list closed')
  assert.equal((app as unknown as { workspaceLease?: unknown }).workspaceLease, undefined, 'the workspace lease is closed')
  assert.ok(!terminal.writes.join('').includes('SIXC'), 'no internal candidate marker reaches Terminal.write')
  assert.ok(!terminal.writes.join('').includes(dcs), 'the closed Viewer raster is never replayed')
})

test('E2-02: a fullscreen transcript body click opens the direct Viewer; text/blank cells stay inert', async (t) => {
  const png = await pngFromRgba(fill(80, 40, (_x, y) => (y < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 80, 40)
  const ref: TranscriptImageRef = { attachmentId: 'att-e2-02', mediaType: 'image/png', bytes: png.byteLength, width: 80, height: 40, name: 'bands.png' }
  const { terminal, app } = await startSixelApp(t, {
    imageLoader: new ImageLoader(async () => ({ ref: {}, data: png })),
    imageTheme: { fallbackColor: (text: string) => text },
  })
  app.setFullscreen(true)
  app.setTranscript(transcriptWithMany([ref]).messages())
  app.requestRender()
  await waitViewport(terminal, '🖼️ bands.png · 80×40', 'the fullscreen transcript row')
  const beforeClick = paintedRasters(terminal).length
  await nextRaster(terminal, beforeClick, 'the transcript raster before the click')
  const view = await viewportOf(terminal)
  const infoRow = rowOf(view, '🖼️ bands.png · 80×40')
  assert.ok(infoRow > 0, view)
  // Inert cells: the info text itself and the empty cells right of an 8-cell
  // wide image never open a Viewer.
  terminal.sendInput(`\x1b[<0;2;${infoRow}M`)
  terminal.sendInput(`\x1b[<0;2;${infoRow}m`)
  assert.equal((app as unknown as { workspaceLease?: unknown }).workspaceLease, undefined, 'the info row opens no Viewer')
  terminal.sendInput(`\x1b[<0;30;${infoRow + 1}M`)
  terminal.sendInput(`\x1b[<0;30;${infoRow + 1}m`)
  assert.equal((app as unknown as { workspaceLease?: unknown }).workspaceLease, undefined, 'blank cells right of the pixels open no Viewer')

  // A real painted body cell opens the direct Viewer (no list below it).
  const beforeViewer = paintedRasters(terminal).length
  terminal.sendInput(`\x1b[<0;4;${infoRow + 1}M`)
  terminal.sendInput(`\x1b[<0;4;${infoRow + 1}m`)
  const dcs = await nextRaster(terminal, beforeViewer, 'the direct Viewer raster')
  const directDecoded = decodeSixel(dcs)
  assert.equal(directDecoded.width, 80, 'the direct Viewer paints the source width')
  assert.ok(pixelAt(directDecoded, 4, 4)[0] > 180, 'the direct Viewer paints the real red band')
  const viewer = await waitViewport(terminal, 'Image · bands.png', 'the direct Viewer')
  assert.ok(stripSgr(viewer).includes('Esc close'), 'a direct open advertises Esc close, never Esc back')
  assert.ok(!viewer.includes('Images · current transcript'), 'escapes directly, no hidden list')
  // Esc closes the Viewer and never opens a list.
  terminal.writes.length = 0
  terminal.sendInput('\x1b')
  const restored = await waitViewport(terminal, '🖼️ bands.png · 80×40', 'the restored transcript')
  assert.equal((app as unknown as { workspaceLease?: unknown }).workspaceLease, undefined, 'Esc close leaves no lease')
  assert.ok(!restored.includes('Images · current transcript'), 'Esc close never opens a list')
  assert.ok(!restored.includes('Image · bands.png'), 'the Viewer chrome is gone after Esc')
})

test('E2-03: JPEG and WebP refs paint their derived PNG while keeping the ORIGINAL metadata', async (t) => {
  const reads = new Map<string, number>()
  let conversions = 0
  const bytesById = new Map<string, Uint8Array>([
    ['att-e2-03-jpeg', SAMPLE_JPEG],
    ['att-e2-03-webp', SAMPLE_WEBP],
  ])
  const loader = new ImageLoader(
    async (ref) => {
      reads.set(ref.attachmentId, (reads.get(ref.attachmentId) ?? 0) + 1)
      return { ref: {}, data: bytesById.get(ref.attachmentId)! }
    },
    undefined,
    async (input, mediaType) => {
      conversions += 1
      const { convertKittyThumbnail } = await import('../../src/client/media/image/kitty-thumbnail.ts')
      return convertKittyThumbnail(input, mediaType)
    },
  )
  const { terminal, app } = await startSixelApp(t, {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text: string) => text },
  })
  const refs: TranscriptImageRef[] = [
    { attachmentId: 'att-e2-03-jpeg', mediaType: 'image/jpeg', bytes: SAMPLE_JPEG.byteLength, width: 120, height: 80, name: 'photo.jpg' },
    { attachmentId: 'att-e2-03-webp', mediaType: 'image/webp', bytes: SAMPLE_WEBP.byteLength, width: 120, height: 80, name: 'shot.webp' },
  ]
  app.setTranscript(transcriptWithMany(refs).messages())
  app.requestRender()
  await waitViewport(terminal, '🖼️ photo.jpg · 120×80', 'the JPEG transcript row')

  app.openTranscriptImagePicker()
  await waitViewport(terminal, 'Images · current transcript', 'the list')
  const beforeJpeg = paintedRasters(terminal).length
  terminal.sendInput('\r')
  const jpegDcs = await nextRaster(terminal, beforeJpeg, 'the JPEG derived-PNG raster')
  const jpegDecoded = decodeSixel(jpegDcs)
  assert.equal(jpegDecoded.width, 120, 'the JPEG Viewer paints the derived PNG width')
  assert.ok(jpegDecoded.height > 0 && jpegDecoded.height % 6 === 0, 'the JPEG Viewer paints a complete band-aligned PNG')
  const jpegView = await waitViewport(terminal, 'Image · photo.jpg', 'the JPEG Viewer')
  assert.ok(jpegView.includes('120×80 · image/jpeg'), `original JPEG metadata stays: ${jpegView}`)
  assert.ok(jpegView.includes(`${SAMPLE_JPEG.byteLength} B`), jpegView)

  // Esc back, move to the WebP and open it: the SAME loader derives its own PNG.
  terminal.sendInput('\x1b')
  await waitViewport(terminal, 'Images · current transcript', 'the list after Esc')
  terminal.sendInput('\x1b[B')
  const beforeWebp = paintedRasters(terminal).length
  terminal.sendInput('\r')
  const webpDcs = await nextRaster(terminal, beforeWebp, 'the WebP derived-PNG raster')
  const webpDecoded = decodeSixel(webpDcs)
  assert.equal(webpDecoded.width, 120, 'the WebP Viewer paints its own derived PNG width')
  assert.ok(webpDecoded.height > 0 && webpDecoded.height % 6 === 0, 'the WebP Viewer paints a complete band-aligned PNG')
  const webpView = await waitViewport(terminal, 'Image · shot.webp', 'the WebP Viewer')
  assert.ok(webpView.includes('120×80 · image/webp'), `original WebP metadata stays: ${webpView}`)
  assert.equal(reads.get('att-e2-03-jpeg'), 1, 'the JPEG raw read happened once')
  assert.equal(reads.get('att-e2-03-webp'), 1, 'the WebP raw read happened once')
  assert.equal(conversions, 2, 'each JPEG/WebP derived exactly one PNG')
  // The viewer keeps the workspace restriction for iTerm2 only; SIXEL painted
  // real pixels above. (The iTerm2/GIF negative paths are component-tested.)
  terminal.sendInput('\x1b')
  await waitViewport(terminal, 'Images · current transcript', 'the list after the WebP Viewer')
  terminal.sendInput('\x1b')
  await waitViewport(terminal, '🖼️ photo.jpg · 120×80', 'the transcript after closing the list')
})

test('E2-04: the Viewer grant survives the frozen resize matrix and a Main↔Alt round trip', async (t) => {
  const png = await pngFromRgba(fill(80, 40, (_x, y) => (y < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 80, 40)
  const ref: TranscriptImageRef = { attachmentId: 'att-e2-04', mediaType: 'image/png', bytes: png.byteLength, width: 80, height: 40, name: 'bands.png' }
  let reads = 0
  const { terminal, app } = await startSixelApp(t, {
    imageLoader: new ImageLoader(async () => {
      reads += 1
      return { ref: {}, data: png }
    }),
    imageTheme: { fallbackColor: (text: string) => text },
  })
  app.setTranscript(transcriptWithMany([ref]).messages())
  app.requestRender()
  await waitViewport(terminal, '🖼️', 'the transcript row')
  app.openTranscriptImagePicker()
  await waitViewport(terminal, 'Images · current transcript', 'the list')
  const beforeViewer = paintedRasters(terminal).length
  terminal.sendInput('\r')
  await nextRaster(terminal, beforeViewer, 'the initial Viewer raster')
  await waitViewport(terminal, 'Image · bands.png', 'the initial Viewer')

  // The frozen size matrix: every real terminal resize re-grants the Viewer's
  // body rows. Each step looks at the bytes THIS resize's frame wrote (or the
  // last committed raster when that frame reused it), never at an older frame
  // that could accidentally satisfy the new ceiling.
  let lastCommittedDcs = paintedRasters(terminal).at(-1)!
  for (const [cols, rows] of [[120, 40], [80, 24], [44, 12], [40, 8], [40, 2], [20, 1]] as const) {
    terminal.writes.length = 0
    terminal.emitResize(cols, rows)
    await until(() => stripSgr(terminal.writes.join('')).includes('Esc'), `${cols}x${rows}: the resize frame with chrome`)
    await terminal.flush()
    const view = await viewportOf(terminal)
    assert.equal(view.split('\n').length, rows, `${cols}x${rows}: the viewport really changed`)
    assert.ok(stripSgr(view).includes('Esc'), `${cols}x${rows}: the mandatory Esc hint survives`)
    const frameRasters = paintedRasters(terminal)
    if (rows <= 2) {
      assert.equal(frameRasters.length, 0, `${cols}x${rows}: the chrome-only frame writes no body raster`)
      continue
    }
    assert.ok(frameRasters.length > 0 || lastCommittedDcs !== undefined, `${cols}x${rows}: a raster remains visible`)
    for (const dcs of frameRasters.length > 0 ? frameRasters : [lastCommittedDcs]) {
      const decoded = decodeSixel(dcs)
      assert.ok(decoded.width <= cols * 10, `${cols}x${rows}: raster width ${decoded.width} fits the grant`)
      assert.ok(decoded.height <= (rows - 2) * 20, `${cols}x${rows}: raster height ${decoded.height} fits body rows`)
    }
    if (frameRasters.length > 0) lastCommittedDcs = frameRasters.at(-1)!
  }
  assert.equal(reads, 1, 'the resize matrix never re-reads the attachment bytes')

  // Alt stop/resume: close, enter the fullscreen transcript, reopen the same
  // leased workspace and come back to the fullscreen surface before Main.
  terminal.emitResize(80, 24)
  await until(() => terminal.writes.length > 0, 'the restore frame')
  terminal.sendInput('\x1b')
  await waitViewport(terminal, 'Images · current transcript', 'the list after the matrix')
  terminal.sendInput('\x1b')
  await waitViewport(terminal, '🖼️ bands.png · 80×40', 'the main screen after the matrix')
  app.setFullscreen(true)
  const fullscreen = await waitViewport(terminal, 'bands.png', 'the fullscreen transcript')
  assert.ok(fullscreen.includes('bands.png'), `the fullscreen transcript paints:\n${fullscreen}`)
  app.openTranscriptImagePicker()
  await waitViewport(terminal, 'Images · current transcript', 'the fullscreen workspace list')
  const beforeAltViewer = paintedRasters(terminal).length
  terminal.sendInput('\r')
  await nextRaster(terminal, beforeAltViewer, 'the fullscreen workspace Viewer raster')
  assert.ok((await waitViewport(terminal, 'Image · bands.png', 'the fullscreen workspace Viewer')).includes('Esc back'))
  terminal.writes.length = 0
  terminal.sendInput('\x1b')
  await waitViewport(terminal, 'Images · current transcript', 'the list after the fullscreen Viewer')
  terminal.sendInput('\x1b')
  const back = await waitViewport(terminal, 'bands.png', 'the fullscreen transcript after the workspace')
  assert.equal((app as unknown as { workspaceLease?: unknown }).workspaceLease, undefined, 'the second Esc closed the workspace')
  assert.ok(!terminal.writes.join('').includes('SIXC'), 'no candidate marker survives the round trip')
  app.setFullscreen(false)
  await waitViewport(terminal, 'bands.png', 'the main transcript after leaving Alt')
})

test('E2-05: a real SVG tool card paints admitted pixels, and malformed SVG paints text only', async (t) => {
  const rasterWidths: number[] = []
  const svgLoader = new SvgRasterLoader(async (source, options) => {
    rasterWidths.push(options.targetWidth)
    return rasterizeSvg(source, options)
  })
  const { terminal, app } = await startSixelApp(t, {
    svgLoader,
    imageTheme: { fallbackColor: (text: string) => text },
  })
  const internals = app as unknown as {
    setTranscript(messages: unknown[]): void
    messages: readonly unknown[]
    toggleMessageExpanded(message: unknown): void
  }
  const mountToolSvg = async (svg: string, title: string, description: string): Promise<string> => {
    const fact = svgFactFromArgs({ title, description, svg })
    const human = svgHumanText(fact)
    const message = {
      kind: 'tool',
      turn: 1,
      name: SVG_TOOL_NAME,
      args: JSON.stringify({ title, description, svg }),
      result: human,
      resultBlocks: [
        { type: 'text', text: human },
        { type: 'text', text: `visual-v1:${JSON.stringify(fact)}` },
      ],
      status: 'ok',
    } as never
    const before = paintedRasters(terminal).length
    internals.setTranscript([message])
    internals.toggleMessageExpanded(internals.messages[0])
    const dcs = await nextRaster(terminal, before, `the ${title} tool raster`)
    return dcs
  }

  // A normal admitted drawing: real pixels and the readable description.
  const normal = await mountToolSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="#3b82f6"/><text x="4" y="20" font-size="12" fill="#ffffff">Gateway</text></svg>',
    'Service topology',
    'Gateway -> App',
  )
  const normalDecoded = decodeSixel(normal)
  assert.ok(normalDecoded.width > 0 && normalDecoded.height > 0)
  const [r, g, b] = pixelAt(normalDecoded, 8, 8)
  assert.ok(b > 180 && r < 100, `the admitted blue fill paints real pixels: ${r},${g},${b}`)
  const normalView = await waitViewport(terminal, 'Service topology', 'the tool card description')
  assert.ok(normalView.includes('Gateway -> App'), normalView)
  assert.equal(rasterWidths.at(-1), 64, 'the tool card rasterized its admitted target width')

  // Over-wide drawing: the real footprint stays inside the thumbnail width cap.
  const wide = await mountToolSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 64"><rect width="640" height="64" fill="#dc2626"/></svg>',
    'Wide topology',
    'A wide drawing',
  )
  const wideDecoded = decodeSixel(wide)
  assert.ok(wideDecoded.width <= 40 * 10, `the over-wide drawing is cell-capped: ${wideDecoded.width}`)
  assert.ok(wideDecoded.height <= 12 * 20, `the over-wide drawing is row-capped: ${wideDecoded.height}`)

  // Semi-transparent fill: the encoder composites over the terminal's REAL
  // OSC 11 background #282c34, so the decoded pixel is a real blend, not a
  // guessed white/black or a transparent hole.
  const transparent = await mountToolSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="#22c55e" fill-opacity="0.5"/></svg>',
    'Transparent drawing',
    'A transparent drawing',
  )
  const transparentDecoded = decodeSixel(transparent)
  const [cr, cg, cb] = pixelAt(transparentDecoded, 8, 8)
  assert.ok(Math.abs(cr - 37) <= 12 && Math.abs(cg - 120) <= 16 && Math.abs(cb - 73) <= 12,
    `the semi-transparent fill composites the verified OSC11 background: ${cr},${cg},${cb}`)

  // Tall and short aspects stay inside the same cell/row budget.
  const tall = await mountToolSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 128"><rect width="32" height="128" fill="#eab308"/></svg>',
    'Tall drawing',
    'A tall drawing',
  )
  const tallDecoded = decodeSixel(tall)
  assert.ok(tallDecoded.width <= 40 * 10, `tall drawing width ${tallDecoded.width} fits`)
  assert.ok(tallDecoded.height <= 12 * 20, `tall drawing height ${tallDecoded.height} fits`)
  assert.ok(tallDecoded.height > tallDecoded.width, 'the tall aspect is preserved')
  const short = await mountToolSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 16"><rect width="640" height="16" fill="#dc2626"/></svg>',
    'Short drawing',
    'A short drawing',
  )
  const shortDecoded = decodeSixel(short)
  assert.ok(shortDecoded.width <= 40 * 10, `short drawing width ${shortDecoded.width} fits`)
  assert.ok(shortDecoded.height <= 12 * 20, `short drawing height ${shortDecoded.height} fits`)
  assert.ok(shortDecoded.width > shortDecoded.height, 'the short aspect is preserved')

  // Malformed evidence: the app's own admission refuses it, paints no DCS and
  // keeps the readable description.
  const badSvg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10"'
  const badFact = svgFactFromArgs({ title: 'Broken drawing', description: 'unparseable', svg: badSvg })
  const badMessage = {
    kind: 'tool',
    turn: 1,
    name: SVG_TOOL_NAME,
    args: JSON.stringify({ title: 'Broken drawing', description: 'unparseable', svg: badSvg }),
    result: svgHumanText(badFact),
    resultBlocks: [
      { type: 'text', text: svgHumanText(badFact) },
      { type: 'text', text: `visual-v1:${JSON.stringify(badFact)}` },
    ],
    status: 'ok',
  } as never
  const beforeBad = paintedRasters(terminal).length
  internals.setTranscript([badMessage])
  internals.toggleMessageExpanded(internals.messages[0])
  const badView = await waitViewport(terminal, 'Broken drawing', 'the malformed card description')
  assert.ok(badView.includes('Broken drawing'))
  assert.equal(paintedRasters(terminal).length, beforeBad, 'malformed SVG emits no trusted DCS')
})

test('E2-06: a published Assistant SIXEL figure exposes the committed hit and its exact boundaries', async (t) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="#3b82f6"/></svg>'
  const svgLoader = new SvgRasterLoader(async (source, options) => rasterizeSvg(source, options))
  const { terminal, app } = await startSixelApp(t, {
    svgLoader,
    imageTheme: { fallbackColor: (text: string) => text },
  })
  app.setFullscreen(true)
  const { folder, assistant } = assistantSvgVisual(svg)
  // Filler answers after the figure make it reachable by scroll and later
  // off-screen, exactly like a real answer above later turns.
  folder.apply(Array.from({ length: 6 }, (_, index) => ({
    type: 'user/message',
    seq: 3 + index,
    time: 10 + index,
    data: { content: [{ type: 'text', text: `filler ${index} ${'x'.repeat(120)}` }], source: { kind: 'user' } },
  })) as never)
  app.setTranscript(folder.messages())
  await waitViewport(terminal, 'filler 5', 'the later answers at the bottom')
  app.scrollToTop()
  const figure = await waitViewport(terminal, 'Service topology', 'the published figure')
  const bodyRecord = (app as unknown as {
    visualAssistantBodies: Map<unknown, {
      indent: number
      body: { paintedVisualHits(width: number): Array<{ actions: unknown[]; thumbnailBody?: { startRow: number; endRow: number; endCol: number; startCol?: number } }> }
    }>
  }).visualAssistantBodies.get(assistant)
  assert.ok(bodyRecord !== undefined, 'the production Assistant body is mounted')
  const innerWidth = (bodyRecord.body as unknown as { paintedFigures?: { width: number } }).paintedFigures?.width
    ?? (terminal.columns - bodyRecord.indent)
  // BEFORE the Screen commits: the same production body has no pixel body.
  const beforeHits = bodyRecord.body.paintedVisualHits(innerWidth)
  assert.equal(beforeHits.length, 1)
  assert.equal(beforeHits[0]!.thumbnailBody, undefined, 'the render-time candidate declares no pixel body')
  await until(() => paintedRasters(terminal).length > 0, 'the figure thumbnail raster')
  // AFTER the commit, without any new component render or layout call: the
  // same body answers the real footprint.
  const afterHits = bodyRecord.body.paintedVisualHits(innerWidth)
  const committed = afterHits[0]!.thumbnailBody
  assert.ok(committed !== undefined, 'the committed frame produces the real hit')
  assert.equal(committed.startCol, 0, 'the Screen puts the DCS at column 1, so the hit starts at 0')
  assert.ok(committed.endRow > committed.startRow)
  assert.ok(committed.endCol > 0)

  // The committed body reaches the fullscreen paint snapshot on the next
  // frame boundary; wait for that snapshot (the press path reads it), then
  // resolve the physical rows from the CURRENT viewport.
  const snapshotHasBody = (): boolean => {
    const rows = (app as unknown as {
      fullscreenPaintSnapshot?: { rows: Array<{ visualHits?: Array<{ kind: string }> }> }
    }).fullscreenPaintSnapshot?.rows ?? []
    return rows.some(row => (row.visualHits ?? []).some(hit => hit.kind === 'body'))
  }
  // The commit's own settle seam marks the row map dirty; request the frame
  // that publishes it (the same path a real pixel settle uses).
  ;(app as unknown as { settleThumbnailRender(): void }).settleThumbnailRender()
  await until(snapshotHasBody, 'the fullscreen paint snapshot to include the committed pixel body')
  const pressView = await viewportOf(terminal)
  const pressTopRow = rowOf(pressView, 'Service topology')
  const pressPixelFirst = pressTopRow + committed.startRow
  assert.ok(pressPixelFirst > pressTopRow)

  const workspaceOpen = (): boolean => (app as unknown as { workspaceLease?: unknown }).workspaceLease !== undefined
  // Title/description, the leading spacer, and the cell just RIGHT of the last
  // painted pixel are all inert. The input path is synchronous, so the lease
  // state is an authoritative immediate probe (no timing window).
  for (const [row, x] of [
    [pressTopRow, 1],
    [pressTopRow + 1, 1],
    [pressTopRow + 2, 1],
    [pressPixelFirst, committed.endCol + 1],
  ] as const) {
    terminal.sendInput(`\x1b[<0;${x};${row}M`)
    terminal.sendInput(`\x1b[<0;${x};${row}m`)
    assert.equal(workspaceOpen(), false, `row ${row} col ${x} is not a pixel hit`)
  }
  await settlePointerWindow()
  // The FIRST and LAST real pixel cells open the leased Viewer. After each
  // close, wait for the transcript repaint and its refreshed press snapshot.
  for (const x of [1, committed.endCol]) {
    ;(app as unknown as { settleThumbnailRender(): void }).settleThumbnailRender()
    await waitViewport(terminal, 'Service topology', `the transcript frame before pixel col ${x}`)
    await until(snapshotHasBody, `the press snapshot before pixel col ${x}`)
    const fresh = await viewportOf(terminal)
    const freshPixelFirst = rowOf(fresh, 'Service topology') + committed.startRow
    terminal.sendInput(`\x1b[<0;${x};${freshPixelFirst}M`)
    terminal.sendInput(`\x1b[<0;${x};${freshPixelFirst}m`)
    const viewer = await waitViewport(terminal, 'SVG · Service topology', `the Viewer from pixel col ${x}`)
    assert.ok(viewer.includes('[Preview]'))
    terminal.sendInput('\x1b')
    await waitViewport(terminal, 'Service topology', 'the transcript after the Viewer')
    await until(() => terminal.writes.join('').includes('\x1b[2K'), 'the screen erase after the Viewer')
    await settlePointerWindow()
  }

  // A later answer scrolled into view releases the off-screen occurrence: the
  // SAME body keeps its layout/actions but exposes no pixel body.
  app.scrollToBottom()
  await waitViewport(terminal, 'filler 5', 'the later answer')
  const offscreen = bodyRecord.body.paintedVisualHits(innerWidth)
  assert.equal(offscreen.length, 1, 'the figure layout entry remains')
  assert.equal(offscreen[0]!.thumbnailBody, undefined, 'an off-screen occurrence offers no pixel hit')
  assert.equal(offscreen[0]!.actions.length, 2, 'the action-row snapshot survives the body loss')

  // Bring the figure back on screen, then let a second screen owner (Settings
  // workspace) cover the transcript: the occurrence is released while the
  // stable action layout is not re-derived.
  app.scrollToTop()
  await waitViewport(terminal, 'Service topology', 'the figure back on screen')
  terminal.writes.length = 0
  const handle = app.openSettingsWorkspace(
    { readSnapshot: () => ({ configReadiness: 'ready' as const, rows: [], capturedAt: 0 }) },
    { aboutVersionFacts: { tui: 'test-bundle', dsh: undefined } },
  )
  await until(() => terminal.writes.join('').includes('\x1b[16t'), 'the covering screen to be observed')
  const covered = bodyRecord.body.paintedVisualHits(innerWidth)
  assert.equal(covered[0]?.thumbnailBody, undefined, 'a covered transcript exposes no pixel hit')
  handle.close()
  await waitViewport(terminal, 'Service topology', 'the transcript after the covering workspace')

  // Revoking the publication's sidecar and rebuilding the answer removes the
  // figure; the retired body no longer answers a pixel body.
  clearAssistantVisualPresentation(assistant)
  app.setTranscript(folder.messages())
  await waitViewportGone(terminal, 'Service topology', 'the revoked figure to disappear')
  assert.equal(bodyRecord.body.paintedVisualHits(innerWidth)[0]?.thumbnailBody, undefined,
    'the revoked publication body offers no pixel hit')
})
test('E2-07: the SIXEL SVG Viewer Preview/Source/Copy/resize/release path', async (t) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="#3b82f6"/><text x="4" y="20" font-size="12" fill="#ffffff">Gateway</text></svg>'
  const rasterWidths: number[] = []
  const copies: string[] = []
  const svgLoader = new SvgRasterLoader(async (source, options) => {
    rasterWidths.push(options.targetWidth)
    return rasterizeSvg(source, options)
  })
  let viewerSubscriptions = 0
  let viewerUnsubscriptions = 0
  const originalSubscribe = svgLoader.subscribe.bind(svgLoader)
  svgLoader.subscribe = (digest, width, listener) => {
    if (width > 64) viewerSubscriptions += 1
    const unsubscribe = originalSubscribe(digest, width, listener)
    return () => {
      if (width > 64) viewerUnsubscriptions += 1
      unsubscribe()
    }
  }
  const { terminal, app } = await startSixelApp(t, {
    svgLoader,
    imageTheme: { fallbackColor: (text: string) => text },
    copySelection: async (text) => { copies.push(text); return true },
  })
  app.setFullscreen(true)
  const { folder } = assistantSvgVisual(svg)
  app.setTranscript(folder.messages())
  const figure = await waitViewport(terminal, 'Service topology', 'the published figure')
  const viewRow = rowOf(figure, 'View')
  const viewX = stripSgr(figure.split('\n')[viewRow - 1]!).indexOf('View') + 1
  const beforeViewer = paintedRasters(terminal).length
  terminal.sendInput(`\x1b[<0;${viewX};${viewRow}M`)
  terminal.sendInput(`\x1b[<0;${viewX};${viewRow}m`)
  const viewer = await waitViewport(terminal, 'SVG · Service topology', 'the View action opener')
  assert.ok(viewer.includes('[Preview]') && viewer.includes('Source'))
  const previewDcs = await nextRaster(terminal, beforeViewer, 'the SVG Viewer preview raster')
  const previewDecoded = decodeSixel(previewDcs)
  assert.ok(previewDecoded.width > 64, `the Viewer requested its OWN larger variant: ${previewDecoded.width}`)
  assert.ok(pixelAt(previewDecoded, 8, 8)[2] > 180, 'the admitted SVG fill paints real blue pixels')
  const lastWidth = rasterWidths.at(-1)!
  assert.ok(lastWidth > 64, `the exact grant variant is wider than the thumbnail: ${lastWidth}`)
  assert.equal(viewerSubscriptions, 1, 'one Viewer variant subscription')

  // Tab to Source: the image DCS disappears and the safe XML is painted.
  terminal.writes.length = 0
  terminal.sendInput('\t')
  const sourceView = await waitViewport(terminal, '<svg', 'the Source page')
  assert.ok(sourceView.includes('[Source]'), sourceView)
  assert.equal(paintedRasters(terminal).length, 0, 'Source paints no image DCS')
  // C copies the raw source; the visible Source is the sanitized projection.
  terminal.sendInput('c')
  await until(() => copies.length === 1, 'the clipboard sink')
  assert.deepEqual(copies, [svg], 'Copy Source sends the raw admitted bytes')

  // Back to Preview and resize: the new exact grant variant is requested and
  // its DCS really lands after the resize frame.
  terminal.sendInput('\t')
  await waitViewport(terminal, '[Preview]', 'the Preview page before the resize')
  terminal.writes.length = 0
  const beforeResize = rasterWidths.length
  terminal.emitResize(80, 24)
  await until(() => rasterWidths.length > beforeResize, 'the resized Viewer variant')
  const resizeDcs = await nextRaster(terminal, paintedRasters(terminal).length, 'the resized Viewer DCS')
  const resizeDecoded = decodeSixel(resizeDcs)
  assert.ok(resizeDecoded.height <= (24 - 2) * 20, 'the resized raster fits the body grant')
  assert.ok(rasterWidths.at(-1)! < lastWidth, `a narrower grant selects a smaller variant: ${rasterWidths.join(',')}`)
  const previewAgain = await waitViewport(terminal, 'SVG · Service topology', 'the Preview after resize')
  assert.ok(previewAgain.includes('[Preview]'))

  // Esc releases the workspace and its exact variant subscription.
  terminal.writes.length = 0
  terminal.sendInput('\x1b')
  await waitViewport(terminal, 'Service topology', 'the transcript after the SVG Viewer')
  assert.ok(viewerUnsubscriptions > 0, 'the Viewer released its variant subscription')
  const widthsAtClose = rasterWidths.length
  await terminal.flush()
  assert.equal(rasterWidths.length, widthsAtClose, 'no raster starts after the Viewer closes')
})

test('E2-07 source safety: the Viewer sanitizes Source while Copy keeps the raw bytes', async (t) => {
  const hostile = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><!-- \u001b]52;c;SGVsbG8=\u0007 --><rect width="64" height="32" fill="#3b82f6"/></svg>'
  const copies: string[] = []
  const svgLoader = new SvgRasterLoader(async (source, options) => rasterizeSvg(source, options))
  const { terminal, app } = await startSixelApp(t, {
    svgLoader,
    imageTheme: { fallbackColor: (text: string) => text },
    copySelection: async (text) => { copies.push(text); return true },
  })
  app.setFullscreen(true)
  const { folder } = assistantSvgVisual(hostile, 'hostile', 'hostile description')
  app.setTranscript(folder.messages())
  const figure = await waitViewport(terminal, 'hostile', 'the refused figure description')
  const viewRow = rowOf(figure, 'View')
  const viewX = stripSgr(figure.split('\n')[viewRow - 1]!).indexOf('View') + 1
  terminal.sendInput(`\x1b[<0;${viewX};${viewRow}M`)
  terminal.sendInput(`\x1b[<0;${viewX};${viewRow}m`)
  const viewer = await waitViewport(terminal, 'SVG · hostile', 'the Source-only Viewer')
  assert.ok(viewer.includes('Preview unavailable'), 'the malformed admission states Preview unavailable')
  terminal.sendInput('\t')
  const source = await waitViewport(terminal, '<svg', 'the Source page')
  assert.ok(source.includes('[Source]'), source)
  // The Source projection drops the terminal-active bytes but Copy keeps the
  // exact admitted source bytes (the same contract as the Kitty viewer).
  assert.equal(source.includes('\u001b]52'), false, 'no OSC sequence reaches the terminal')
  assert.equal(source.includes('\u0007'), false, 'no BEL reaches the terminal')
  terminal.sendInput('c')
  await until(() => copies.length === 1, 'the hostile-source clipboard sink')
  assert.deepEqual(copies, [hostile], 'Copy sends the RAW source unchanged')
  terminal.sendInput('\x1b')
  await waitViewport(terminal, 'hostile', 'the transcript after the Source-only Viewer')
})

test('E2-08: SVG Viewer width variants, page switching, close/reopen and crop stay bounded', async (t) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="#3b82f6"/></svg>'
  const rasterWidths: number[] = []
  const svgLoader = new SvgRasterLoader(async (source, options) => {
    rasterWidths.push(options.targetWidth)
    return rasterizeSvg(source, options)
  })
  let viewerUnsubscriptions = 0
  const originalSubscribe = svgLoader.subscribe.bind(svgLoader)
  svgLoader.subscribe = (digest, width, listener) => {
    const unsubscribe = originalSubscribe(digest, width, listener)
    return () => {
      if (width > 64) viewerUnsubscriptions += 1
      unsubscribe()
    }
  }
  const { terminal, app } = await startSixelApp(t, {
    svgLoader,
    imageTheme: { fallbackColor: (text: string) => text },
  })
  app.setFullscreen(true)
  const { folder } = assistantSvgVisual(svg)
  app.setTranscript(folder.messages())
  const figure = await waitViewport(terminal, 'Service topology', 'the published figure')
  const clickView = async (): Promise<void> => {
    const view = await viewportOf(terminal)
    const row = rowOf(view, 'View')
    const x = stripSgr(view.split('\n')[row - 1]!).indexOf('View') + 1
    terminal.sendInput(`\x1b[<0;${x};${row}M`)
    terminal.sendInput(`\x1b[<0;${x};${row}m`)
  }
  await clickView()
  await waitViewport(terminal, 'SVG · Service topology', 'the first SVG Viewer')

  // Wider and narrower grants select DIFFERENT exact target widths, and each
  // resize frame really writes its new raster.
  terminal.writes.length = 0
  const beforeWide = rasterWidths.length
  terminal.emitResize(120, 40)
  await until(() => rasterWidths.length > beforeWide, 'the wide Viewer variant')
  const wideVariant = rasterWidths.at(-1)!
  const wideDcs = await nextRaster(terminal, 0, 'the wide Viewer DCS')
  assert.ok(decodeSixel(wideDcs).width > 64)
  terminal.writes.length = 0
  const beforeNarrow = rasterWidths.length
  terminal.emitResize(44, 12)
  await until(() => rasterWidths.length > beforeNarrow, 'the narrow Viewer variant')
  const narrowVariant = rasterWidths.at(-1)!
  const narrowDcs = await nextRaster(terminal, 0, 'the narrow Viewer DCS')
  const narrowDecoded = decodeSixel(narrowDcs)
  assert.ok(narrowVariant < wideVariant, `distinct exact widths: ${wideVariant} -> ${narrowVariant}`)
  assert.ok(narrowDecoded.height <= (12 - 2) * 20, 'the crop fits the shorter body grant')
  assert.ok(narrowDecoded.height % 6 === 0, 'the crop is SIXEL-band aligned')
  assert.ok(narrowDcs.endsWith('\x1b\\'), 'one complete DCS')

  // Preview ↔ Source repeatedly: every Source frame paints no DCS, and every
  // return to Preview re-commits its raster through the Screen.
  for (let round = 0; round < 3; round += 1) {
    terminal.writes.length = 0
    terminal.sendInput('\t')
    await waitViewport(terminal, '[Source]', `the Source page round ${round}`)
    assert.equal(paintedRasters(terminal).length, 0, `Source round ${round} paints no image DCS`)
    terminal.writes.length = 0
    terminal.sendInput('\t')
    await waitViewport(terminal, '[Preview]', `the Preview page round ${round}`)
    await nextRaster(terminal, 0, `the Preview raster round ${round}`)
  }

  // Restore the original geometry before closing so the transcript chrome is
  // fully visible again, then close: the workspace releases the exact variant
  // subscription; the transcript thumbnail re-encodes.
  terminal.emitResize(100, 24)
  await until(() => rasterWidths.length > beforeNarrow + 1, 'the restored Viewer variant')
  await waitViewport(terminal, 'SVG · Service topology', 'the Viewer after restoring geometry')
  terminal.writes.length = 0
  terminal.sendInput('\x1b')
  await waitViewport(terminal, 'Service topology', 'the transcript after the first Viewer')
  await until(() => paintedRasters(terminal).length > 0, 'the transcript thumbnail re-encode')
  assert.ok(viewerUnsubscriptions > 0, 'closing the Viewer releases its variant subscription')
  assert.ok(!terminal.writes.join('').includes('SIXC'), 'no Viewer candidate marker survives the close')

  // Reopen from the SAME figure through its real View action; the new Viewer
  // paints a fresh raster instead of recycling the closed token.
  terminal.writes.length = 0
  await clickView()
  const reopened = await waitViewport(terminal, 'SVG · Service topology', 'the reopened SVG Viewer')
  assert.ok(reopened.includes('[Preview]'))
  const reopenedDcs = await nextRaster(terminal, 0, 'the reopened Viewer DCS')
  assert.ok(decodeSixel(reopenedDcs).width > 64, 'the reopened Viewer paints its own pixels')
  terminal.sendInput('\x1b')
  const back = await waitViewport(terminal, 'Service topology', 'the transcript after the reopened Viewer')
  assert.ok(back.includes('Service topology'), 'the transcript is restored after the reopened Viewer')
})
test('E2-09: a long 24-image transcript fills the registry, then re-encodes old images and the SVG Viewer', async (t) => {
  const pngs: Uint8Array[] = []
  for (let index = 0; index < 24; index += 1) {
    pngs.push(await pngFromRgba(fill(80, 40, (x, y) => (y < 20 ? [255, (index * 7) % 255, x % 2 === 0 ? 0 : 8, 255] : [0, 0, 255, 255])), 80, 40))
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="#22c55e"/></svg>'
  const svgLoader = new SvgRasterLoader(async (source, options) => rasterizeSvg(source, options))
  const { terminal, app } = await startSixelApp(t, {
    imageLoader: new ImageLoader(async (ref) => {
      const index = Number(ref.attachmentId.split('-').at(-1))
      return { ref: {}, data: pngs[index]! }
    }),
    imageTheme: { fallbackColor: (text: string) => text },
    svgLoader,
  })
  // A tall real terminal makes all 24 distinct messages visible at once: the
  // owner can grant only its 16-variant budget, so the oldest images stay text.
  terminal.emitResize(100, 200)
  await until(() => terminal.writes.join('').includes('\x1b[16t'), 'the tall-screen re-observation')
  const refs: TranscriptImageRef[] = pngs.map((png, index) => ({
    attachmentId: `att-e2-09-${index}`,
    mediaType: 'image/png' as const,
    bytes: png.byteLength,
    width: 80,
    height: 40,
    name: `many-${index}.png`,
  }))
  const folder = transcriptWithMany(refs)
  const { folder: svgFolder } = assistantSvgVisual(svg)
  app.setTranscript([...folder.messages(), ...svgFolder.messages()])
  app.requestRender()
  await waitViewport(terminal, 'Service topology', 'the published SVG after the long image history')

  /** The green top-band value of every distinct image raster currently encoded. */
  const encodedImageColors = (): Set<number> => {
    const colors = new Set<number>()
    for (const dcs of paintedRasters(terminal)) {
      try {
        const decoded = decodeSixel(dcs)
        const [red, green] = pixelAt(decoded, 4, 4)
        if (red > 180) colors.add(green)
      } catch {
        // A partial DCS fragment is not an encoded image.
      }
    }
    return colors
  }
  // The visible SVG thumbnail also consumes one of the 16 slots, so 15
  // distinct IMAGE variants + the SVG variant fill the budget exactly.
  await until(() => encodedImageColors().size >= 15, '15 distinct visible image variants', 60_000)
  assert.ok(encodedImageColors().size <= 16, 'the 16-variant registry cap is preserved')
  assert.ok(paintedRasters(terminal).length < 300, `no unbounded retry storm: ${paintedRasters(terminal).length} rasters`)

  // Open the OLDEST image through the REAL /view-image LIST journey; its slot
  // was released under the 16-variant budget, so this must re-encode it.
  app.openTranscriptImagePicker()
  await waitViewport(terminal, 'Images · current transcript', 'the image list')
  const beforeOldViewer = paintedRasters(terminal).length
  terminal.sendInput('\r')
  await waitViewport(terminal, 'Image · many-0.png', 'the oldest image Viewer')
  await until(() => paintedRasters(terminal).length > beforeOldViewer, 'the oldest image re-encode')
  const oldRaster = decodeSixel(paintedRasters(terminal).at(-1)!)
  assert.ok(pixelAt(oldRaster, 4, 4)[0] > 180 && pixelAt(oldRaster, 4, 4)[1] === 0,
    'the oldest image is re-encoded, not a stale/fallback raster')
  terminal.sendInput('\x1b')
  await waitViewport(terminal, 'Images · current transcript', 'the image list after the Viewer')
  terminal.sendInput('\x1b')
  await waitViewport(terminal, 'Service topology', 'the transcript after the image list')

  // The published SVG Viewer still gets its OWN variant after the 24 image
  // occurrences and the re-encode above.
  app.setFullscreen(true)
  const figure = await waitViewport(terminal, 'Service topology', 'the fullscreen published figure')
  const viewRow = rowOf(figure, 'View')
  const viewX = stripSgr(figure.split('\n')[viewRow - 1]!).indexOf('View') + 1
  const beforeSvgViewer = paintedRasters(terminal).length
  terminal.sendInput(`\x1b[<0;${viewX};${viewRow}M`)
  terminal.sendInput(`\x1b[<0;${viewX};${viewRow}m`)
  await waitViewport(terminal, 'SVG · Service topology', 'the SVG Viewer')
  await until(() => paintedRasters(terminal).length > beforeSvgViewer, 'the SVG Viewer raster')
  const svgDecoded = decodeSixel(paintedRasters(terminal).at(-1)!)
  const [red, green] = pixelAt(svgDecoded, 8, 8)
  assert.ok(green > 120 && red < 120, `the SVG pixels still encode: ${red},${green}`)
  assert.ok(paintedRasters(terminal).length < 400, `the whole journey stays bounded: ${paintedRasters(terminal).length} rasters`)
  terminal.sendInput('\x1b')
  await waitViewport(terminal, 'Service topology', 'the transcript after the SVG Viewer')
})

test('E2 negative: PI_IMAGE_PROTOCOL=none fails closed with no raster, read or encode', async (t) => {
  const previous = process.env.PI_IMAGE_PROTOCOL
  process.env.PI_IMAGE_PROTOCOL = 'none'
  t.after(() => {
    if (previous === undefined) delete process.env.PI_IMAGE_PROTOCOL
    else process.env.PI_IMAGE_PROTOCOL = previous
  })
  const png = await pngFromRgba(fill(80, 40, () => [255, 0, 0, 255]), 80, 40)
  let reads = 0
  const { terminal, app } = await startSixelApp(t, {
    imageLoader: new ImageLoader(async () => {
      reads += 1
      return { ref: {}, data: png }
    }),
    imageTheme: { fallbackColor: (text: string) => text },
    skipSixelReadiness: true,
  })
  const ref: TranscriptImageRef = { attachmentId: 'att-e2-neg', mediaType: 'image/png', bytes: png.byteLength, width: 80, height: 40, name: 'denied.png' }
  app.setTranscript(transcriptWithMany([ref]).messages())
  app.requestRender()
  await waitViewport(terminal, 'denied.png', 'the transcript chip')
  app.openTranscriptImagePicker()
  await waitViewport(terminal, 'Images · current transcript', 'the list')
  const before = paintedRasters(terminal).length
  terminal.sendInput('\r')
  const viewer = await waitViewport(terminal, 'Image · denied.png', 'the Viewer metadata')
  assert.ok(stripSgr(viewer).includes('Preview unavailable'), 'the denied surface states it truthfully')
  assert.equal(paintedRasters(terminal).length, before, 'no DCS is produced')
  assert.equal(reads, 0, 'no image bytes are read when the protocol is denied')
  terminal.sendInput('\x1b')
  await waitViewport(terminal, 'denied.png', 'the transcript after the denied Viewer')
})

test('E2-02 negative: an unsupported raster and a narrow layout expose no image body hit', async (t) => {
  const png = await pngFromRgba(fill(80, 40, () => [255, 0, 0, 255]), 80, 40)
  const gifRef: TranscriptImageRef = { attachmentId: 'att-e2-gif', mediaType: 'image/gif', bytes: png.byteLength, width: 80, height: 40, name: 'anim.gif' }
  const { terminal, app } = await startSixelApp(t, {
    imageLoader: new ImageLoader(async () => ({ ref: {}, data: png })),
    imageTheme: { fallbackColor: (text: string) => text },
  })
  app.setFullscreen(true)
  app.setTranscript(transcriptWithMany([gifRef]).messages())
  const view = await waitViewport(terminal, 'anim.gif', 'the GIF fallback row')
  const infoRow = rowOf(view, '🖼️ anim.gif')
  assert.ok(infoRow > 0, view)
  // The fallback row is informational: no painted pixel body may become a hit.
  terminal.sendInput(`\x1b[<0;4;${infoRow + 1}M`)
  terminal.sendInput(`\x1b[<0;4;${infoRow + 1}m`)
  assert.equal((app as unknown as { workspaceLease?: unknown }).workspaceLease, undefined,
    'the text fallback opens no Viewer')
  // A narrow layout paints the info row only and keeps the same rule.
  terminal.emitResize(40, 24)
  await waitViewport(terminal, 'anim.gif', 'the narrow GIF row')
  const narrow = await viewportOf(terminal)
  const narrowInfo = rowOf(narrow, 'anim.gif')
  terminal.sendInput(`\x1b[<0;4;${narrowInfo + 1}M`)
  terminal.sendInput(`\x1b[<0;4;${narrowInfo + 1}m`)
  assert.equal((app as unknown as { workspaceLease?: unknown }).workspaceLease, undefined,
    'the narrow fallback opens no Viewer')
})
