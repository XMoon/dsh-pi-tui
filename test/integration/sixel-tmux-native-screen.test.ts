/**
 * Image-8 / I8-4 — native tmux SIXEL through the real product chain.
 *
 * Every E2 below composes the real production classes:
 *
 *   TuiApp → product media consumers → the ONE SixelGraphicsOwner
 *     → SixelEncoder → TuiMainScreen/TuiAltScreen (X073/X074)
 *     → TmuxSixelTerminal (trusted DCS gate) → inner Terminal.write
 *
 * The tmux server is the real scripted subprocess fixture: factory admission,
 * live client identity and Sxl all come from its raw stdout. The inner
 * terminal is a VirtualTerminal recording the exact physical bytes; the
 * independent SIXEL oracle decodes them. What this does NOT prove is that a
 * real outer terminal paints those bytes — that is the separate physical
 * tmux smoke, which a synthetic terminal cannot replace.
 * @module @xmoon76/dsh-pi-tui/integration/sixel-tmux-native-screen.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resetCapabilitiesCache } from '@xmoon76/pi-tui'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import type { TuiAppEvents } from '../../src/tui-app.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import { rasterizeSvg } from '../../src/client/media/svg/rasterize.ts'
import { setAssistantVisualPresentation, type VisualPresentationKey } from '../../src/domain/visual/presentation.ts'
import { svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'
import { TranscriptFolder, type TranscriptMessage } from '../../src/transcript.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { effectiveImageProtocol } from '../../src/tui/graphics/image-capability.ts'
import { decodeSixel, pixelAt } from '../support/sixel-oracle.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { createFakeTmuxCli, type FakeTmuxCli } from '../support/fake-tmux-cli.ts'

/** A real terminal face; the Screen's cell/background queries are answered. */
class TmuxSixelAppTerminal extends VirtualTerminal {
  private readonly cellWidthPx: number
  private readonly cellHeightPx: number

  constructor(columns: number, rows: number, cellWidthPx = 10, cellHeightPx = 20) {
    super(columns, rows)
    this.cellWidthPx = cellWidthPx
    this.cellHeightPx = cellHeightPx
  }

  override write(data: string): void {
    super.write(data)
    if (data.includes('\x1b[16t')) {
      setImmediate(() => this.sendInput(`\x1b[6;${this.cellHeightPx};${this.cellWidthPx}t`))
    }
    if (data.includes('\x1b]11;?')) {
      setImmediate(() => this.sendInput('\x1b]11;rgb:2828/2c2c/3434\x07'))
    }
  }
}

async function until(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

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

/** Every complete DCS the physical sink received, in write order. */
function paintedRasters(terminal: VirtualTerminal): string[] {
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

/**
 * The sink must never see a SIXEL introducer without its terminator in the
 * SAME physical write: the facade reassembles any DCS the fork's 1 MiB writer
 * split, so only a complete command ever reaches the terminal.
 */
function assertNoSplitSixelAtSink(terminal: VirtualTerminal): void {
  for (const [index, chunk] of terminal.writes.entries()) {
    let cursor = chunk.indexOf('\x1bP0;1;q')
    while (cursor >= 0) {
      const end = chunk.indexOf('\x1b\\', cursor + 2)
      assert.ok(end >= 0, `sink write ${index} contains a partial managed DCS`)
      cursor = chunk.indexOf('\x1bP0;1;q', end + 2)
    }
  }
}

const ENVIRONMENT_KEYS = [
  'PATH', 'TMUX', 'TMUX_PANE', 'TERM', 'ZELLIJ', 'STY', 'TERM_PROGRAM', 'PI_IMAGE_PROTOCOL',
  'PI_TUI_TMUX_KITTY_IMAGES', 'PI_TUI_TMUX_KITTY_PLACEHOLDERS', 'KITTY_WINDOW_ID', 'WT_SESSION',
  'GHOSTTY_RESOURCES_DIR', 'WEZTERM_PANE', 'ITERM_SESSION_ID', 'WARP_SESSION_ID',
] as const

function enableNativeSixel(cli: FakeTmuxCli): void {
  cli.setArgvReply(['display-message', '-p', '-t', '%7', '#{sixel_support}'], { text: '1\n' })
  cli.setReply('show-messages', { text: '  1: Sxl: (flag) true\n' })
}

function installFakeServerEnv(t: test.TestContext, cli: FakeTmuxCli): void {
  const keys = new Set<string>([...ENVIRONMENT_KEYS, ...Object.keys(cli.env)])
  const saved = new Map<string, string | undefined>()
  for (const key of keys) saved.set(key, process.env[key])
  for (const key of keys) delete process.env[key]
  for (const [key, value] of Object.entries(cli.env)) {
    if (value !== undefined) process.env[key] = value
  }
  t.after(() => {
    for (const key of keys) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

interface AppFixture {
  readonly terminal: TmuxSixelAppTerminal
  readonly app: TuiApp
  readonly store: DraftImageStore
  readonly cli: FakeTmuxCli
}

/** Bring up the real app on a scripted native-tmux-SIXEL server. */
async function startTmuxSixelApp(
  t: test.TestContext,
  options: {
    imageLoader?: ImageLoader
    imageTheme?: { fallbackColor: (text: string) => string }
    svgLoader?: SvgRasterLoader
    clientReport?: string
    cellWidthPx?: number
    cellHeightPx?: number
  } = {},
): Promise<AppFixture> {
  const cli = createFakeTmuxCli(t)
  enableNativeSixel(cli)
  // The native SIXEL path is for clients whose U1 support is NOT a known
  // positive: a Kitty/Ghostty report would (correctly) keep the tmux virtual
  // transport instead. E04 owns that precedence case explicitly.
  cli.setReply('list-clients', {
    text: options.clientReport ?? 'main\t/dev/pts/12\twork\txterm-256color\txterm(1.0)\t0\n',
  })
  installFakeServerEnv(t, cli)

  const home = testLifecycle(t).tempDir('tmux-sixel-app-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  resetCapabilitiesCache()
  const terminal = new TmuxSixelAppTerminal(
    100,
    24,
    options.cellWidthPx ?? 10,
    options.cellHeightPx ?? 20,
  )
  const store = new DraftImageStore()
  const app = new TuiApp(
    terminal,
    {
      onSubmit: () => {},
      onExit: () => {},
      onCancel: () => {},
      runOwned: (_label: string, task: () => unknown) => {
        void Promise.resolve(task()).catch(() => {})
      },
    } as TuiAppEvents,
    {
      draftImagePreviewSource: { values: () => store.values() },
      ...(options.imageLoader === undefined ? {} : { imageLoader: options.imageLoader }),
      ...(options.imageTheme === undefined ? {} : { imageTheme: options.imageTheme }),
      ...(options.svgLoader === undefined ? {} : { svgRasterLoader: options.svgLoader }),
    },
  )
  t.after(() => app.dispose())
  t.after(() => cli.dispose())
  app.start()

  const graphics = (app as unknown as { graphics?: { mode: string } }).graphics
  assert.equal(graphics?.mode, 'sixel', `the production factory selected the native tmux SIXEL handle; calls=${cli.calls().join(' | ')}`)
  // The real `CSI 16t` + OSC 11 observations come from the fixture terminal;
  // they prove the app sampled them, never that tmux rendered pixels.
  await until(() => terminal.writes.join('').includes('\x1b[16t'), 'the `CSI 16t` geometry query')
  await until(() => terminal.writes.join('').includes('\x1b]11;?'), 'the OSC 11 background query')
  await tick()

  return { terminal, app, store, cli }
}

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

async function viewportOf(terminal: TmuxSixelAppTerminal): Promise<string> {
  await terminal.flush()
  return terminal.getViewport().join('\n')
}

/** One Assistant answer with one published SVG (the real sidecar path). */
function assistantSvgVisual(svg: string, title = 'Service topology', description = 'Gateway -> App'): TranscriptFolder {
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
          id: MessageId('tmux-sixel-assistant-svg'),
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
  return folder
}

/** The real JPEG/WebP fixtures the transcript tests already own. */
const SAMPLE_JPEG = readFileSync(new URL('../fixtures/images/transcript-sample.jpg', import.meta.url))
const SAMPLE_WEBP = readFileSync(new URL('../fixtures/images/transcript-sample.webp', import.meta.url))

// ── E01: one complete trusted DCS, decoded ──────────────────────────────────

test('E01: the real app paints a product Draft PNG through the native tmux SIXEL chain', async (t) => {
  const { terminal, app, store } = await startTmuxSixelApp(t)
  const png = await pngFromRgba(fill(80, 40, (_x, y) => (y < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 80, 40)
  const image = store.add({ bytes: png, mediaType: 'image/png', width: 80, height: 40, name: 'bands.png' })

  terminal.writes.length = 0
  terminal.sendInput(image.placeholder)
  await until(() => paintedRasters(terminal).length > 0, 'the draft card raster')

  const wire = terminal.writes.join('')
  assert.ok(!wire.includes('\x1b_G'), 'no Kitty APC is emitted on a SIXEL frame')
  assert.ok(!wire.includes('\x1bPtmux;'), 'the DCS is not wrapped in a tmux passthrough envelope')
  assertNoSplitSixelAtSink(terminal)
  const rasters = paintedRasters(terminal)
  const decoded = decodeSixel(rasters.at(-1)!)
  assert.equal(decoded.width, 80)
  assert.ok(decoded.height > 0 && decoded.height % 6 === 0)
  const [topR, topG, topB] = pixelAt(decoded, 4, 4)
  assert.ok(topR > 180 && topG < 80 && topB < 80, `the top band is red, got ${topR},${topG},${topB}`)
  const [, , bottomBlue] = pixelAt(decoded, 4, decoded.height - 8)
  assert.ok(bottomBlue > 180, 'the bottom band is blue')
  assert.equal(effectiveImageProtocol((app as unknown as { graphics: never }).graphics), 'sixel')
})

// ── E02: Main transcript and Fullscreen Alt, one owner ──────────────────────

test('E02: transcript Main and Fullscreen Alt both paint through the same owner', async (t) => {
  const red = await pngFromRgba(fill(80, 40, () => [255, 0, 0, 255]), 80, 40)
  const green = await pngFromRgba(fill(80, 40, () => [0, 220, 0, 255]), 80, 40)
  const bytesById = new Map([['att-e02-red', red], ['att-e02-green', green]])
  const { terminal, app } = await startTmuxSixelApp(t, {
    imageLoader: new ImageLoader(async (ref) => ({ ref: {}, data: bytesById.get(ref.attachmentId)! })),
    imageTheme: { fallbackColor: (text: string) => text },
  })
  const refs: TranscriptImageRef[] = [
    { attachmentId: 'att-e02-red', mediaType: 'image/png', bytes: red.byteLength, width: 80, height: 40, name: 'red.png' },
    { attachmentId: 'att-e02-green', mediaType: 'image/png', bytes: green.byteLength, width: 80, height: 40, name: 'green.png' },
  ]

  terminal.writes.length = 0
  app.setTranscript(transcriptWithMany(refs).messages())
  app.requestRender()
  await until(() => paintedRasters(terminal).length > 0, 'the Main transcript raster')
  const mainRasters = paintedRasters(terminal)
  assert.ok(mainRasters.length >= 1)
  const mainDecoded = decodeSixel(mainRasters.at(-1)!)
  assert.ok(pixelAt(mainDecoded, 4, 4)[1] > 150, 'the newest visible Main image is the green source')

  terminal.writes.length = 0
  app.setFullscreen(true)
  await until(() => paintedRasters(terminal).length > 0, 'the Fullscreen Alt raster')
  assertNoSplitSixelAtSink(terminal)
  const altDecoded = decodeSixel(paintedRasters(terminal).at(-1)!)
  assert.ok(pixelAt(altDecoded, 4, 4)[1] > 150, 'the Alt screen paints the same source through the same owner')
  const altWire = terminal.writes.join('')
  const dcs = paintedRasters(terminal).at(-1)!
  const anchorAt = altWire.lastIndexOf(dcs)
  assert.ok(anchorAt > altWire.lastIndexOf('🖼️'), 'the Alt command follows the text pass')
  assert.strictEqual(altWire.indexOf('\x1bP', anchorAt + 1), -1, 'exactly one DCS in that Alt frame')

  terminal.writes.length = 0
  app.setFullscreen(false)
  await tick(200)
  assert.ok(!terminal.writes.join('').includes('SIXC'), 'no candidate marker reaches Terminal.write')
})

// ── E03: JPEG/WebP product consumers ────────────────────────────────────────

test('E03: Draft JPEG/WebP and the transcript image Viewer keep their product paths', async (t) => {
  const jpegBytes = new Uint8Array(SAMPLE_JPEG)
  const webpBytes = new Uint8Array(SAMPLE_WEBP)
  const { terminal, app, store } = await startTmuxSixelApp(t, {
    imageLoader: new ImageLoader(async (ref) => {
      const id = String((ref as { attachmentId?: string }).attachmentId ?? '')
      if (id === 'att-e03-jpeg') return { ref: {}, data: jpegBytes }
      return { ref: {}, data: webpBytes }
    }),
    imageTheme: { fallbackColor: (text: string) => text },
    svgLoader: new SvgRasterLoader(async (source, options) => rasterizeSvg(source, options)),
  })

  const jpeg = store.add({ bytes: jpegBytes, mediaType: 'image/jpeg', width: 120, height: 80, name: 'photo.jpg' })
  terminal.writes.length = 0
  terminal.sendInput(jpeg.placeholder)
  await until(() => paintedRasters(terminal).length > 0, 'the Draft JPEG raster')
  assert.ok(decodeSixel(paintedRasters(terminal).at(-1)!).width > 0)

  const webp = store.add({ bytes: webpBytes, mediaType: 'image/webp', width: 120, height: 80, name: 'shot.webp' })
  terminal.writes.length = 0
  terminal.sendInput(webp.placeholder)
  await until(() => paintedRasters(terminal).length > 0, 'the Draft WebP raster')
  assert.ok(decodeSixel(paintedRasters(terminal).at(-1)!).width > 0)

  const ref: TranscriptImageRef = {
    attachmentId: 'att-e03-jpeg', mediaType: 'image/jpeg', bytes: jpegBytes.byteLength, width: 120, height: 80, name: 'photo.jpg',
  }
  terminal.writes.length = 0
  app.setTranscript(transcriptWithMany([ref]).messages())
  app.requestRender()
  await until(() => paintedRasters(terminal).length > 0, 'the transcript JPEG raster')
  terminal.writes.length = 0
  app.openTranscriptImagePicker()
  await until(() => terminal.getViewport().join('\n').includes('Images · current transcript'), 'the image picker')
  terminal.sendInput('\r')
  await until(() => paintedRasters(terminal).length > 0, 'the Viewer raster')
  assert.ok(decodeSixel(paintedRasters(terminal).at(-1)!).width > 0)
})

test('E03b: the Assistant SVG thumbnail keeps the existing raster loader on native tmux SIXEL', async (t) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="#3b82f6"/></svg>'
  const { terminal, app } = await startTmuxSixelApp(t, {
    svgLoader: new SvgRasterLoader(async (source, options) => rasterizeSvg(source, options)),
    imageTheme: { fallbackColor: (text: string) => text },
  })
  app.setFullscreen(true)
  terminal.writes.length = 0
  app.setTranscript(assistantSvgVisual(svg).messages())
  app.requestRender()
  await until(() => terminal.getViewport().join('\n').includes('Service topology'), 'the Assistant SVG card')
  await until(() => paintedRasters(terminal).length > 0, 'the SVG thumbnail raster')
  const svgDecoded = decodeSixel(paintedRasters(terminal).at(-1)!)
  assert.ok(svgDecoded.width > 0 && svgDecoded.height > 0, 'the existing SVG loader produced real pixels')
})

// ── E05: the fork's 1 MiB writer split must never leak a partial DCS ────────

test('E05: a >1 MiB raster split by the main-screen writer is reassembled before the sink', async (t) => {
  // Large noise source: the encoded SIXEL payload exceeds one 1 MiB writer
  // chunk, which is the real fork contract this facade must survive.
  const png = await pngFromRgba(fill(800, 600, (x, y) => {
    const n = (x * 7 + y * 13) % 256
    return [(n * 37) & 255, (n * 97) & 255, (n * 131) & 255, 255]
  }), 800, 600)
  const { terminal, app } = await startTmuxSixelApp(t, {
    imageLoader: new ImageLoader(async () => ({ ref: {}, data: png })),
    imageTheme: { fallbackColor: (text: string) => text },
    cellWidthPx: 20,
    cellHeightPx: 40,
  })
  const ref = { attachmentId: 'att-e05-noise', mediaType: 'image/png' as const, bytes: png.byteLength, width: 800, height: 600, name: 'noise.png' }

  app.setTranscript(transcriptWith(ref).messages())
  app.requestRender()
  await until(() => terminal.getViewport().join('\n').includes('🖼️'), 'the transcript identity row')
  terminal.writes.length = 0
  app.requestRender()
  await until(() => paintedRasters(terminal).length > 0, 'the large noise main-screen raster')
  const rasters = paintedRasters(terminal)
  const dcs = rasters.at(-1)!
  const decodedProbe = decodeSixel(dcs)
  assert.ok(dcs.length > 1024 * 1024,
    `the encoded DCS really spans a 1 MiB writer chunk (${dcs.length} chars; ${decodedProbe.width}x${decodedProbe.height}; all=${rasters.map(r => r.length).join(',')})`)
  assertNoSplitSixelAtSink(terminal)
  assert.ok(decodedProbe.width > 0)
})

// ── E06: a client change between two DCS of one physical frame ─────────────

test('E06: a client change between two same-frame DCS lets the second write zero managed bytes', async (t) => {
  const red = await pngFromRgba(fill(80, 40, () => [255, 0, 0, 255]), 80, 40)
  const green = await pngFromRgba(fill(80, 40, () => [0, 220, 0, 255]), 80, 40)
  const bytesById = new Map([['att-e06-red', red], ['att-e06-green', green]])
  const fixture = await startTmuxSixelApp(t, {
    imageLoader: new ImageLoader(async (ref) => ({ ref: {}, data: bytesById.get(ref.attachmentId)! })),
    imageTheme: { fallbackColor: (text: string) => text },
  })
  const { terminal, app, cli } = fixture
  let changed = false
  const innerWrite = terminal.write.bind(terminal)
  terminal.write = (data: string): void => {
    if (!changed && data.includes('\x1bP0;1;q')) {
      changed = true
      cli.setReply('show-messages', { text: '  1: Sxl: (flag) false\n' })
    }
    innerWrite(data)
  }
  app.setTranscript(transcriptWithMany([
    { attachmentId: 'att-e06-red', mediaType: 'image/png', bytes: red.byteLength, width: 80, height: 40, name: 'red.png' },
    { attachmentId: 'att-e06-green', mediaType: 'image/png', bytes: green.byteLength, width: 80, height: 40, name: 'green.png' },
  ]).messages())
  terminal.writes.length = 0
  app.setFullscreen(true)
  await until(() => changed, 'the first DCS to reach the sink')
  await tick(200)
  assert.equal(paintedRasters(terminal).length, 1, 'the first command may land; the second is refused')
  const graphics = (app as unknown as { graphics: { canPaint(): boolean } }).graphics
  await tick(300) // reason: let the 250 ms render probe TTL expire before asserting revocation
  assert.equal(graphics.canPaint(), false, 'the client change latched a one-way revocation')
  assert.equal(effectiveImageProtocol(graphics as never), null)
})

// ── E07: a client change in the middle of one split DCS ────────────────────

test('E07: a client change before a split DCS completes writes zero managed prefix bytes', async (t) => {
  const png = await pngFromRgba(fill(800, 600, (x, y) => {
    const n = (x * 7 + y * 13) % 256
    return [(n * 37) & 255, (n * 97) & 255, (n * 131) & 255, 255]
  }), 800, 600)
  const { terminal, app, cli } = await startTmuxSixelApp(t, {
    imageLoader: new ImageLoader(async () => ({ ref: {}, data: png })),
    imageTheme: { fallbackColor: (text: string) => text },
    cellWidthPx: 20,
    cellHeightPx: 40,
  })
  const ref = { attachmentId: 'att-e07-noise', mediaType: 'image/png' as const, bytes: png.byteLength, width: 800, height: 600, name: 'noise.png' }
  const facade = (app as unknown as { graphics: { terminal: { write(data: string): void } } }).graphics.terminal
  let changed = false
  let prefixLeakedBeforeChange = false
  const original = facade.write.bind(facade)
  facade.write = (data: string): void => {
    // Feed the FIRST 1 MiB chunk through the production facade BEFORE changing
    // the client: at this point the facade has held the partial managed DCS
    // (its introducer is not on the sink) and no DCS bytes were written. Only
    // then flip Sxl, so the remaining chunk must be refused by the write-time
    // forced re-probe, not by an initial admission failure.
    original(data)
    if (!changed && data.includes('\x1bP0;1;q')) {
      prefixLeakedBeforeChange = terminal.writes.join('').includes('\x1bP0;1;q')
      changed = true
      cli.setReply('show-messages', { text: '  1: Sxl: (flag) false\n' })
    }
  }
  terminal.writes.length = 0
  app.setTranscript(transcriptWith(ref).messages())
  app.requestRender()
  await until(() => changed, 'the first chunk to be processed and held by the facade')
  assert.equal(prefixLeakedBeforeChange, false, 'the first held prefix never reached the sink before the change')
  await tick(300)
  assert.equal(paintedRasters(terminal).length, 0, 'no managed DCS byte reached the sink')
  assert.equal(terminal.writes.join('').includes('\x1bP0;1;q'), false, 'not even the first physical prefix leaked')
})

// ── E08: revocation drops paintable facts and forces full text repaint ─────

test('E08: after a live revocation the old raster is not a ghost hit and the surface repaints text', async (t) => {
  const png = await pngFromRgba(fill(80, 40, () => [255, 0, 0, 255]), 80, 40)
  const { terminal, app, store, cli } = await startTmuxSixelApp(t)
  const image = store.add({ bytes: png, mediaType: 'image/png', width: 80, height: 40, name: 'red.png' })
  terminal.writes.length = 0
  terminal.sendInput(image.placeholder)
  await until(() => paintedRasters(terminal).length > 0, 'the initial raster')
  const dcs = paintedRasters(terminal).at(-1)!
  const graphics = (app as unknown as { graphics: { canPaint(): boolean; screen: { footprint(dcs: string): unknown } } }).graphics
  assert.ok(graphics.screen.footprint(dcs), 'the painted DCS is trusted before the revocation')

  cli.setReply('show-messages', { text: '  1: Sxl: (flag) false\n' })
  await tick(300) // reason: let the 250 ms render probe TTL expire
  terminal.writes.length = 0
  app.requestRender()
  await until(() => terminal.writes.length > 0, 'the forced text repaint')
  await tick(200)
  assert.equal(graphics.canPaint(), false)
  assert.equal(graphics.screen.footprint(dcs), undefined, 'the registry dropped the paint fact; no ghost click can resolve')
  assert.equal(paintedRasters(terminal).length, 0, 'the repaint contains no managed DCS')
})

// ── E04: the existing transport precedence is unchanged ────────────────────

test('E04: known-U1 Kitty, hard-off and non-tmux topologies never fall into tmux SIXEL', async (t) => {
  const { createTmuxKittyGraphics } = await import('../../src/tui/graphics/tmux-image.ts')
  const { createTmuxSixelGraphics } = await import('../../src/tui/graphics/tmux-sixel.ts')
  const cli = createFakeTmuxCli(t)
  enableNativeSixel(cli)
  try {
    const knownKitty = createTmuxKittyGraphics(new VirtualTerminal(), {}, cli.env)
    assert.ok(knownKitty, 'the known Kitty client still gets the tmux virtual transport')
    assert.equal(knownKitty.mode, 'tmux-virtual')
    assert.equal(createTmuxSixelGraphics(new VirtualTerminal(), cli.env), undefined,
      'a trustworthy U1 positive keeps its fixed precedence and creates no SIXEL owner')
    knownKitty.dispose()

    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\txterm(1.0)\t0\n' })
    const pendingKitty = createTmuxKittyGraphics(new VirtualTerminal(), {}, cli.env)
    assert.ok(pendingKitty, 'an unknown renderer still gets the old pending Kitty handle')
    const sixel = createTmuxSixelGraphics(new VirtualTerminal(), cli.env)
    assert.ok(sixel, 'the real Sxl positive outranks the pending U1 probe')
    sixel.dispose()
    pendingKitty.dispose()

    for (const [key, value] of [
      ['PI_IMAGE_PROTOCOL', 'none'],
      ['PI_IMAGE_PROTOCOL', '0'],
      ['PI_IMAGE_PROTOCOL', 'kitty'],
      ['PI_IMAGE_PROTOCOL', 'iterm2'],
      ['ZELLIJ', '1'],
      ['STY', '1'],
    ] as const) {
      assert.equal(createTmuxSixelGraphics(new VirtualTerminal(), { ...cli.env, [key]: value }), undefined,
        `${key}=${value} stays text/legacy`)
    }
  } finally {
    cli.dispose()
  }
})

// ── E09: Screen epoch and registry bounds on the shared owner ──────────────

test('E09: a resize and Main↔Alt re-sample the owner without leaking a stale worker', async (t) => {
  const png = await pngFromRgba(fill(80, 40, () => [255, 0, 0, 255]), 80, 40)
  const { terminal, app, store } = await startTmuxSixelApp(t)
  const image = store.add({ bytes: png, mediaType: 'image/png', width: 80, height: 40, name: 'red.png' })
  terminal.writes.length = 0
  terminal.sendInput(image.placeholder)
  await until(() => paintedRasters(terminal).length > 0, 'the pre-resize raster')

  // A real terminal resize must re-observe the same Screen's facts and repaint.
  terminal.writes.length = 0
  terminal.resize(90, 24)
  await until(() => terminal.writes.join('').includes('\x1b[16t'), 'the resize re-observation')
  await until(() => paintedRasters(terminal).length > 0, 'the post-resize raster')

  // Main → Alt → Main uses the same owner; no candidate marker can escape.
  terminal.writes.length = 0
  app.setFullscreen(true)
  await until(() => paintedRasters(terminal).length > 0, 'the Alt raster')
  terminal.writes.length = 0
  app.setFullscreen(false)
  await tick(200)
  assert.ok(!terminal.writes.join('').includes('SIXC'), 'no stale candidate marker leaks after the screen swap')
})
// ── E10: ordinary IO errors vs the SIXEL refusal error ─────────────────────

test('E10: an ordinary write error propagates unchanged; only the SIXEL refusal becomes a safe repaint', async (t) => {
  const cli = createFakeTmuxCli(t)
  enableNativeSixel(cli)
  try {
    const { TmuxSixelTerminal } = await import('../../src/tui/graphics/tmux-sixel.ts')
    const { TmuxSixelAdmission, probeTmuxSixelIdentity } = await import('../../src/tui/graphics/tmux-sixel-admission.ts')
    const { TmuxGraphicsRevokedError } = await import('../../src/tui/graphics/kitty-terminal.ts')
    const identity = probeTmuxSixelIdentity(cli.env)
    assert.ok(identity)
    const admissions = new TmuxSixelAdmission(identity, cli.env)
    const ioError = new Error('physical sink failed')
    const sinkWrites: string[] = []
    const inner = {
      columns: 80,
      rows: 24,
      kittyProtocolActive: false,
      start: () => {},
      stop: () => {},
      drainInput: async () => {},
      moveBy: () => {},
      hideCursor: () => {},
      showCursor: () => {},
      clearLine: () => {},
      clearFromCursor: () => {},
      clearScreen: () => {},
      setTitle: () => {},
      setProgress: () => {},
      setProgramStatus: () => {},
      write: (data: string) => {
        if (data === 'plain-text') throw ioError
        sinkWrites.push(data)
      },
    } as never
    const facade = new TmuxSixelTerminal(inner, admissions, () => true)
    assert.throws(() => facade.write('plain-text'), (error) => error === ioError,
      'an ordinary IO error keeps its identity, never a safe-repaint conversion')
    facade.dispose()

    const second = new TmuxSixelAdmission(identity, cli.env)
    const gated = new TmuxSixelTerminal(inner, second, () => true)
    cli.setReply('show-messages', { text: '  1: Sxl: (flag) false\n' })
    let refused: unknown
    try {
      gated.write('\x1bP0;1;q#0;2;0;0;0#1;2;100;0;0#0~~@@\x1b\\')
    } catch (error) {
      refused = error
    }
    assert.ok(refused instanceof TmuxGraphicsRevokedError)
    assert.deepEqual(sinkWrites, [], 'the refused DCS wrote zero bytes')
  } finally {
    cli.dispose()
  }
})

// ── E11: pure text frames never probe the tmux CLI ─────────────────────────

test('E11: a text-only frame stream does not spawn per-frame tmux probes', async (t) => {
  const { terminal, app, cli } = await startTmuxSixelApp(t)
  app.requestRender()
  await tick(60)
  const baseline = cli.calls().length
  terminal.writes.length = 0
  for (let index = 0; index < 8; index += 1) {
    terminal.sendInput('x')
    app.requestRender()
    await tick(10)
  }
  await until(() => terminal.writes.length > 0, 'a text frame')
  assert.ok(cli.calls().length - baseline <= 4,
    `plain text frames spawn at most ONE 250 ms-cached probe, not one per frame (delta=${cli.calls().length - baseline})`)
  assert.equal(paintedRasters(terminal).length, 0)
})
