/**
 * Image-8 / I8-5 — Zellij native SIXEL through the real product chain (E2).
 *
 * Every case builds the REAL `TuiApp` over a `VirtualTerminal` that answers the
 * same live pane probes a real Zellij pane answers: the one `a=q` query, the
 * passive primary DA1 (attribute 4), `CSI 16t` cell size and OSC 11
 * background, plus the bounded `CSI c` re-query. The only stand-in is the
 * physical terminal and the scripted Zellij program version; every graphics
 * owner, Screen, media consumer and the SIXEL encoder are production classes.
 *
 * Evidence level: E2 (real factory + real Screen + real encoder + real sink
 * bytes). Real Zellij GUI pixels are the separate physical smoke matrix.
 * @module @xmoon76/dsh-pi-tui/integration/sixel-zellij-native-screen.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resetCapabilitiesCache } from '@xmoon76/pi-tui'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { ImageCache } from '../../src/client/media/image/cache.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { convertKittyThumbnail } from '../../src/client/media/image/kitty-thumbnail.ts'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import { rasterizeSvg } from '../../src/client/media/svg/rasterize.ts'
import { setAssistantVisualPresentation } from '../../src/domain/visual/presentation.ts'
import { svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'
import { TranscriptFolder, type TranscriptMessage } from '../../src/transcript.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { effectiveImageProtocol } from '../../src/tui/graphics/image-capability.ts'
import type { ImageGraphics } from '../../src/tui/graphics/native-image.ts'
import type { ZellijNegotiatedGraphics } from '../../src/tui/graphics/zellij-sixel.ts'
import { createFakeZellijCli, type FakeZellijCli } from '../support/fake-zellij-cli.ts'
import { decodeSixel, pixelAt } from '../support/sixel-oracle.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const SAMPLE_PNG = readFileSync(new URL('../fixtures/images/transcript-sample.png', import.meta.url))
const SAMPLE_JPEG = readFileSync(new URL('../fixtures/images/transcript-sample.jpg', import.meta.url))
const SAMPLE_WEBP = readFileSync(new URL('../fixtures/images/transcript-sample.webp', import.meta.url))

const ENV_KEYS = [
  'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'GHOSTTY_RESOURCES_DIR', 'KITTY_WINDOW_ID',
  'ITERM_SESSION_ID', 'TMUX', 'TMUX_PANE', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'STY', 'WEZTERM_PANE',
  'WARP_SESSION_ID', 'WARP_TERMINAL_SESSION_UUID', 'PI_IMAGE_PROTOCOL', 'PI_TUI_TMUX_KITTY_IMAGES',
  'PI_TUI_TMUX_KITTY_PLACEHOLDERS', 'WT_SESSION',
] as const

/** A real terminal face whose pane probes are answered deterministically. */
class ZellijSixelAppTerminal extends VirtualTerminal {
  readonly cellWidthPx: number
  readonly cellHeightPx: number
  /** Every bounded `CSI c` re-query the product wrote. */
  requeries = 0
  private readonly sixelListeners = new Set<(supported: boolean) => void>()
  private lastSixel: boolean | undefined

  constructor(columns: number, rows: number, cellWidthPx = 10, cellHeightPx = 20) {
    super(columns, rows)
    this.cellWidthPx = cellWidthPx
    this.cellHeightPx = cellHeightPx
  }

  onSixelSupport(listener: (supported: boolean) => void): () => void {
    this.sixelListeners.add(listener)
    if (this.lastSixel !== undefined) listener(this.lastSixel)
    return () => {
      this.sixelListeners.delete(listener)
    }
  }

  /** Emit one complete primary DA1 through the real input path. */
  declareDa1(supported: boolean): void {
    const changed = this.lastSixel !== supported
    this.lastSixel = supported
    if (changed) for (const listener of [...this.sixelListeners]) listener(supported)
    this.sendInput(primaryDa1(supported))
  }

  override write(data: string): void {
    super.write(data)
    if (data.includes('\x1b[16t')) {
      setImmediate(() => this.sendInput(`\x1b[6;${this.cellHeightPx};${this.cellWidthPx}t`))
    }
    if (data.includes('\x1b]11;?')) {
      setImmediate(() => this.sendInput('\x1b]11;rgb:2828/2c2c/3434\x07'))
    }
    if (data.includes('\x1b[c')) {
      this.requeries += 1
      // The re-query reply has the SAME primary DA1 shape; the fake keeps the
      // production parser's dedupe, so an unchanged true value reaches the
      // facade's consume hook without a second listener call.
      setImmediate(() => this.sendInput(primaryDa1(this.lastSixel ?? false)))
    }
  }
}

function primaryDa1(supported: boolean): string {
  return supported ? '\x1b[?4;1;2c' : '\x1b[?1;2c'
}

function probeReply(vt: VirtualTerminal, payload = 'OK'): string {
  const match = /a=q,i=(\d+)/.exec(vt.writes.join(''))
  assert.ok(match, 'the real TuiApp sent a live Zellij query')
  return `\x1b_Gi=${match[1]};${payload}\x1b\\`
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

async function settle(app: TuiApp, vt: VirtualTerminal): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    app.requestRender()
    await new Promise(resolve => setTimeout(resolve, 15))
    await vt.waitForRender()
  }
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

interface MediaCounter {
  readonly loader: ImageLoader
  readonly reads: Map<string, number>
  readonly conversions: () => number
}

function countingLoader(): MediaCounter {
  let conversions = 0
  const reads = new Map<string, number>()
  const loader = new ImageLoader(
    async (ref) => {
      reads.set(ref.attachmentId, (reads.get(ref.attachmentId) ?? 0) + 1)
      const bytes = ref.mediaType === 'image/jpeg' ? SAMPLE_JPEG
        : ref.mediaType === 'image/webp' ? SAMPLE_WEBP
          : SAMPLE_PNG
      return { ref: {}, data: bytes }
    },
    new ImageCache(),
    async (input, mediaType) => {
      conversions += 1
      return convertKittyThumbnail(input, mediaType)
    },
  )
  return { loader, reads, conversions: () => conversions }
}

interface AppFixture {
  readonly terminal: ZellijSixelAppTerminal
  readonly app: TuiApp
  readonly graphics: ZellijNegotiatedGraphics
  readonly store: DraftImageStore
  readonly loader: ImageLoader
  readonly reads: Map<string, number>
  readonly conversions: () => number
  readonly svgLoader: SvgRasterLoader
}

interface StartOptions {
  version?: string
  kitty?: 'ok' | 'denied' | 'timeout'
  da1?: boolean
  /** Leave the live pane answers to the test (a Viewer opened before settle). */
  deferSettle?: boolean
  /** Extra terminal environment facts applied after the fixture defaults. */
  environment?: Record<string, string | undefined>
  cellWidthPx?: number
  cellHeightPx?: number
  imageLoader?: ImageLoader
  svgLoader?: SvgRasterLoader
}

function applyEnvironment(environment: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>()
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[key] = value
  }
  resetCapabilitiesCache()
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetCapabilitiesCache()
  }
}

async function startZellijSixelApp(t: test.TestContext, options: StartOptions = {}): Promise<AppFixture> {
  const cli: FakeZellijCli = createFakeZellijCli(t, options.version ?? 'zellij 0.45.1\n')
  const environment: Record<string, string | undefined> = { ...cli.env }
  for (const key of ENV_KEYS) delete environment[key]
  Object.assign(environment, {
    TERM: 'xterm-256color',
    ZELLIJ: '0',
    ZELLIJ_SESSION_NAME: 'zellij-sixel-itest',
    PI_TUI_TMUX_KITTY_IMAGES: '0',
  })
  for (const [key, value] of Object.entries(options.environment ?? {})) {
    if (value === undefined) delete environment[key]
    else environment[key] = value
  }
  const restore = applyEnvironment(environment)
  t.after(restore)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = testLifecycle(t).tempDir('zellij-sixel-app-')
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  const media = options.imageLoader === undefined ? countingLoader() : undefined
  const loader = options.imageLoader ?? media!.loader
  let reads = media?.reads ?? new Map<string, number>()
  let conversions = media?.conversions ?? (() => 0)
  const store = new DraftImageStore()
  const svgLoader = options.svgLoader ?? new SvgRasterLoader(async (source, rasterOptions) => rasterizeSvg(source, rasterOptions))
  const terminal = new ZellijSixelAppTerminal(120, 30, options.cellWidthPx ?? 10, options.cellHeightPx ?? 20)
  const app = new TuiApp(terminal, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text: string) => text },
    draftImagePreviewSource: { values: () => store.values() },
    draftImagePreviewLiveDraft: read => store.setLiveDraftTextSource(read),
    draftImagePreviewReserve: text => store.pinReferenced(text),
    draftImagePreviewUndo: {
      registerUndoOwner: (owner, retireDraftImage) => store.registerUndoOwner(owner, retireDraftImage),
      releaseUndoForOwner: owner => store.releaseUndoForOwner(owner),
      reconcileUndoOwner: (owner, placeholders) => store.reconcileUndoOwner(owner, placeholders),
    },
    svgRasterLoader: svgLoader,
  })
  t.after(() => app.dispose())
  app.start()
  const graphics = (app as unknown as { graphics: ImageGraphics | undefined }).graphics
  assert.ok(graphics, 'the Zellij pane must create one negotiated graphics handle')
  assert.equal(graphics.mode, 'zellij-negotiated')

  if (options.deferSettle === true) {
    return {
      terminal,
      app,
      graphics,
      store,
      loader,
      reads,
      conversions: () => conversions(),
      svgLoader,
    }
  }
  if (options.da1 !== false) terminal.declareDa1(true)
  if (options.kitty === 'ok') terminal.sendInput(probeReply(terminal))
  else if (options.kitty !== 'timeout') terminal.sendInput(probeReply(terminal, 'ENOTSUPPORTED:disabled'))

  if (options.kitty === 'ok') {
    await until(() => graphics.selectedProtocol() === 'kitty', 'the live Kitty OK')
  } else {
    await until(() => graphics.selectedProtocol() === 'sixel', 'the live SIXEL selection')
    await until(() => graphics.canPaint(), 'the SIXEL owner facts')
  }
  return {
    terminal,
    app,
    graphics,
    store,
    loader,
    reads,
    conversions: () => conversions(),
    svgLoader,
  }
}

function transcriptOf(ref: ImageAttachmentRefLike): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.apply([{
    type: 'user/message',
    seq: 1,
    time: 1,
    data: { content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } },
  } as never])
  return folder
}

function imageRef(attachmentId: string, name: string, mediaType: ImageAttachmentRefLike['mediaType']): ImageAttachmentRefLike {
  const bytes = mediaType === 'image/jpeg' ? SAMPLE_JPEG : mediaType === 'image/webp' ? SAMPLE_WEBP : SAMPLE_PNG
  return { attachmentId, mediaType, bytes: bytes.byteLength, width: 120, height: 80, name }
}

/** One Assistant answer with one published SVG (the real sidecar path). */
function assistantSvgVisual(svg: string): TranscriptFolder {
  const fact = svgFactFromArgs({ title: 'Service topology', description: 'Gateway -> App', svg })
  const folder = new TranscriptFolder()
  folder.apply([{
    type: 'assistant/message',
    seq: 1,
    time: 2,
    data: {
      turn: 0,
      step: 0,
      message: {
        id: 'zellij-sixel-svg',
        role: 'assistant',
        content: [{ type: 'text', text: 'Before.\n\n[dsh-visual-sv1_' + 'a'.repeat(20) + ']: <#>\n\nAfter.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    },
  } as never])
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
  setAssistantVisualPresentation(assistant, {
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
  }, [publication])
  return folder
}

// ── Z01b/Z06b/Z08b: explicit preference and the strict WT auto filter ──────

test('Z01b: auto strict WT ignores the startup Kitty OK and paints SIXEL through the real TuiApp', async (t) => {
  const h = await startZellijSixelApp(t, {
    deferSettle: true,
    environment: {
      WT_SESSION: 'wt-session',
      TERM_PROGRAM: 'Windows_Terminal',
      TERM: 'xterm-256color',
    },
  })
  h.terminal.declareDa1(true)
  h.terminal.sendInput(probeReply(h.terminal))
  await until(() => h.graphics.selectedProtocol() === 'sixel', 'the filtered WT negotiation')
  await until(() => h.graphics.canPaint(), 'the SIXEL owner facts')
  assert.equal(h.terminal.writes.join('').includes('\x1b_Ga=t'), false, 'zero Kitty upload after the false OK')

  const png = await pngFromRgba(fill(80, 40, () => [255, 0, 0, 255]), 80, 40)
  const image = h.store.add({ bytes: png, mediaType: 'image/png', width: 80, height: 40, name: 'wt.png' })
  h.terminal.writes.length = 0
  h.terminal.sendInput(image.placeholder)
  await until(() => paintedRasters(h.terminal).length > 0, 'the real product SIXEL raster')
  const wire = h.terminal.writes.join('')
  assert.equal(wire.includes('\x1b_Ga=t'), false, 'no Kitty delegate ever painted')
  assert.equal(wire.includes('a=p,'), false, 'no Kitty placement ever painted')
  assert.ok(decodeSixel(paintedRasters(h.terminal).at(-1)!).width > 0)
})

test('Z06b: explicit sixel sends no Kitty query and paints through the same real product chain', async (t) => {
  const h = await startZellijSixelApp(t, {
    deferSettle: true,
    environment: { PI_IMAGE_PROTOCOL: 'sixel' },
  })
  assert.equal(h.terminal.writes.join('').includes('a=q,'), false, 'zero Kitty probe bytes')
  h.terminal.declareDa1(true)
  await until(() => h.graphics.selectedProtocol() === 'sixel', 'the explicit SIXEL selection')
  await until(() => h.graphics.canPaint(), 'the SIXEL owner facts')
  const png = await pngFromRgba(fill(80, 40, () => [0, 220, 0, 255]), 80, 40)
  const image = h.store.add({ bytes: png, mediaType: 'image/png', width: 80, height: 40, name: 'forced.png' })
  h.terminal.writes.length = 0
  h.terminal.sendInput(image.placeholder)
  await until(() => paintedRasters(h.terminal).length > 0, 'the explicit SIXEL raster')
  assert.equal(h.terminal.writes.join('').includes('\x1b_G'), false, 'no Kitty bytes at all')
})

test('Z08b: explicit kitty overrides the strict WT auto filter and keeps only Kitty', async (t) => {
  const h = await startZellijSixelApp(t, {
    deferSettle: true,
    environment: {
      PI_IMAGE_PROTOCOL: 'kitty',
      WT_SESSION: 'wt-session',
      TERM_PROGRAM: 'Windows_Terminal',
      TERM: 'xterm-256color',
    },
  })
  h.terminal.declareDa1(true)
  h.terminal.sendInput(probeReply(h.terminal))
  await until(() => h.graphics.selectedProtocol() === 'kitty', 'the explicit Kitty selection')
  assert.equal(h.terminal.writes.join('').includes('\x1bP0;1;q'), false, 'zero SIXEL DCS')
})

// ── ZE01: Kitty timeout + DA1 positive paints one real SIXEL DCS ──────────

test('ZE01: a Draft PNG paints through the Zellij SIXEL chain after the Kitty timeout', async (t) => {
  const h = await startZellijSixelApp(t, { kitty: 'timeout' })
  const png = await pngFromRgba(fill(80, 40, (_x, y) => (y < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 80, 40)
  const image = h.store.add({ bytes: png, mediaType: 'image/png', width: 80, height: 40, name: 'bands.png' })
  h.terminal.writes.length = 0
  h.terminal.sendInput(image.placeholder)
  await until(() => paintedRasters(h.terminal).length > 0, 'the Zellij SIXEL draft raster')

  const wire = h.terminal.writes.join('')
  assert.equal(wire.includes('\x1b_Ga=t'), false, 'no Kitty upload on a SIXEL frame')
  assert.equal(wire.includes('\x1bPtmux;'), false, 'no tmux passthrough envelope')
  assertNoSplitSixelAtSink(h.terminal)
  const decoded = decodeSixel(paintedRasters(h.terminal).at(-1)!)
  assert.equal(decoded.width, 80)
  assert.ok(decoded.height > 0 && decoded.height % 6 === 0)
  const [topR, topG, topB] = pixelAt(decoded, 4, 4)
  assert.ok(topR > 180 && topG < 80 && topB < 80, `top band red, got ${topR},${topG},${topB}`)
  const [, , bottomBlue] = pixelAt(decoded, 4, decoded.height - 8)
  assert.ok(bottomBlue > 180, 'bottom band blue')
  assert.equal(effectiveImageProtocol(h.graphics), 'sixel')
})

// ── ZE02: a live Kitty OK keeps the old Kitty path and emits zero SIXEL ───

test('ZE02: a live Kitty OK keeps the Native path and emits zero SIXEL DCS', async (t) => {
  const h = await startZellijSixelApp(t, { kitty: 'ok', da1: true })
  const ref = imageRef('att-zellij-kitty', 'kitty.png', 'image/png')
  h.app.setTranscript(transcriptOf(ref).messages())
  await until(() => h.reads.get(ref.attachmentId) === 1, 'the Kitty payload read')
  await settle(h.app, h.terminal)
  const wire = h.terminal.writes.join('')
  assert.ok(wire.includes('a=t,f=100') && wire.includes('a=p,'), 'the managed Kitty wire reached the sink')
  assert.equal(wire.includes('\x1bP0;1;q'), false, 'zero SIXEL DCS')
  assert.equal(effectiveImageProtocol(h.graphics), 'kitty')
})

// ── ZE03: Main and Fullscreen Alt share the one SIXEL owner ────────────────

test('ZE03: Main transcript and Fullscreen Alt paint through the same Zellij SIXEL owner', async (t) => {
  const red = await pngFromRgba(fill(80, 40, () => [255, 0, 0, 255]), 80, 40)
  const green = await pngFromRgba(fill(80, 40, () => [0, 220, 0, 255]), 80, 40)
  const bytesById = new Map([['att-ze03-red', red], ['att-ze03-green', green]])
  const loader = new ImageLoader(async (ref) => ({ ref: {}, data: bytesById.get(ref.attachmentId)! }))
  const h = await startZellijSixelApp(t, { imageLoader: loader })
  const refs: ImageAttachmentRefLike[] = [
    { attachmentId: 'att-ze03-red', mediaType: 'image/png', bytes: red.byteLength, width: 80, height: 40, name: 'red.png' },
    { attachmentId: 'att-ze03-green', mediaType: 'image/png', bytes: green.byteLength, width: 80, height: 40, name: 'green.png' },
  ]
  const folder = new TranscriptFolder()
  folder.apply(refs.map((ref, index) => ({
    type: 'user/message',
    seq: index + 1,
    time: index + 1,
    data: { content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } },
  })) as never)
  h.terminal.writes.length = 0
  h.app.setTranscript(folder.messages())
  await until(() => paintedRasters(h.terminal).length > 0, 'the Main raster')
  const main = decodeSixel(paintedRasters(h.terminal).at(-1)!)
  assert.ok(pixelAt(main, 4, 4)[1] > 150, 'the newest visible Main image is green')

  h.terminal.writes.length = 0
  h.app.setFullscreen(true)
  await until(() => paintedRasters(h.terminal).length > 0, 'the Fullscreen Alt raster')
  const alt = decodeSixel(paintedRasters(h.terminal).at(-1)!)
  assert.ok(pixelAt(alt, 4, 4)[1] > 150, 'Alt paints the same source')
  assert.equal((h.app as unknown as { graphics: unknown }).graphics, h.graphics, 'one owner across Main/Alt')
})


// ── ZE06b: a tall image is bounded by the real Screen crop ────────────────

test('ZE06b: a tall transcript image is cropped inside the real fullscreen viewport', async (t) => {
  const tall = await pngFromRgba(fill(80, 400, (x, y) => {
    const n = (x * 11 + y * 7) % 256
    return [n, (n * 3) & 255, (n * 5) & 255, 255]
  }), 80, 400)
  const loader = new ImageLoader(async () => ({ ref: {}, data: tall }))
  const h = await startZellijSixelApp(t, { imageLoader: loader })
  const ref: ImageAttachmentRefLike = {
    attachmentId: 'att-ze06b-tall',
    mediaType: 'image/png',
    bytes: tall.byteLength,
    width: 80,
    height: 400,
    name: 'tall.png',
  }
  h.app.setTranscript(transcriptOf(ref).messages())
  h.app.setFullscreen(true)
  await until(() => paintedRasters(h.terminal).length > 0, 'the tall fullscreen raster')
  const dcs = paintedRasters(h.terminal).at(-1)!
  const footprint = h.graphics.sixelScreen.footprint(dcs)
  assert.notEqual(footprint, undefined)
  const decoded = decodeSixel(dcs)
  assert.ok(decoded.width > 0)
  assert.ok(decoded.height <= footprint!.rows * h.terminal.rows, 'the raster is bounded by its cell footprint')
  assert.ok(footprint!.rows <= h.terminal.rows, 'the crop does not reserve rows outside the physical screen')
  // A terminal resize must re-encode/re-fit through the same owner, never
  // replay the old DCS bytes.
  h.terminal.resize(80, 16)
  await settle(h.app, h.terminal)
  assert.equal(h.graphics.selectedProtocol(), 'sixel')
})

// ── ZE07: transparent first band width/color ──────────────────────────────

test('ZE07: a fully transparent first band keeps its declared width and the second band color', async (t) => {
  const png = await pngFromRgba(fill(80, 40, (_x, y) => (y < 20 ? [0, 0, 0, 0] : [255, 0, 0, 255])), 80, 40)
  const h = await startZellijSixelApp(t)
  const image = h.store.add({ bytes: png, mediaType: 'image/png', width: 80, height: 40, name: 'transparent.png' })
  h.terminal.writes.length = 0
  h.terminal.sendInput(image.placeholder)
  await until(() => paintedRasters(h.terminal).length > 0, 'the transparent-first-band raster')
  const dcs = paintedRasters(h.terminal).at(-1)!
  const decoded = decodeSixel(dcs)
  assert.equal(decoded.width, 80, 'the declared width is preserved')
  assert.ok((decoded.paintedBounds?.top ?? 0) >= 6, 'the first band stays transparent')
  const [r, g, b, a] = pixelAt(decoded, 4, decoded.height - 8)
  assert.equal(a, 255)
  assert.ok(r > 180 && g < 80 && b < 80, 'the second band is red')
  assert.ok(dcs.includes('!80?$'), 'the bounded transparent run is present')
})

// ── ZE09: removing the source leaves no DCS replay ────────────────────────

test('ZE09: removing a Zellij SIXEL image replays no old DCS and keeps text clean', async (t) => {
  const png = await pngFromRgba(fill(80, 40, () => [255, 0, 0, 255]), 80, 40)
  const h = await startZellijSixelApp(t)
  const image = h.store.add({ bytes: png, mediaType: 'image/png', width: 80, height: 40, name: 'red.png' })
  h.terminal.writes.length = 0
  h.terminal.sendInput(image.placeholder)
  await until(() => paintedRasters(h.terminal).length > 0, 'the initial raster')
  h.terminal.writes.length = 0
  h.app.setDraft('')
  await settle(h.app, h.terminal)
  assert.equal(paintedRasters(h.terminal).length, 0, 'removal emits no DCS')
  assert.ok(!h.terminal.writes.join('').includes('SIXC'), 'no internal marker reaches the sink')
})

// ── ZE12: a Viewer opened while pending upgrades in place ─────────────────

test('ZE12: a Viewer opened while the pane is still negotiating paints after the SIXEL settle', async (t) => {
  const png = await pngFromRgba(fill(80, 40, () => [0, 220, 0, 255]), 80, 40)
  const h = await startZellijSixelApp(t, { deferSettle: true })
  const ref = imageRef('att-ze12-viewer', 'viewer.png', 'image/png')
  h.app.setTranscript(transcriptOf(ref).messages())
  h.app.requestRender()
  await h.terminal.waitForRender()
  assert.equal(h.graphics.selectedProtocol(), null, 'the negotiation is still pending')

  // Open the Image picker → Viewer while the negotiated handle is pending:
  // the leased Alt Screen is constructed before the protocol is known.
  h.app.openTranscriptImagePicker()
  await until(() => h.terminal.getViewport().join('\n').includes('Images · current transcript'), 'the Image picker')
  const kittyReply = probeReply(h.terminal, 'ENOTSUPPORTED:disabled')
  h.terminal.writes.length = 0
  h.terminal.sendInput('\r')
  await h.terminal.waitForRender()
  assert.equal(h.graphics.selectedProtocol(), null, 'the Viewer is mounted before the settle')
  assert.equal(paintedRasters(h.terminal).length, 0, 'a pending Viewer paints text')

  // Now the real pane answers: Kitty is denied, DA1 declares SIXEL.
  h.terminal.declareDa1(true)
  h.terminal.sendInput(kittyReply)
  await until(() => h.graphics.selectedProtocol() === 'sixel', 'the live SIXEL selection')
  await until(() => paintedRasters(h.terminal).length > 0, 'the Viewer raster after settle')
  assert.equal(effectiveImageProtocol(h.graphics), 'sixel')
  const decoded = decodeSixel(paintedRasters(h.terminal).at(-1)!)
  assert.ok(decoded.width > 0 && decoded.height > 0, 'the Viewer paints a real raster after the settle')
})

// ── ZE04: JPEG/WebP product consumers ─────────────────────────────────────

test('ZE04: Draft JPEG/WebP and the transcript image Viewer keep their product paths', async (t) => {
  const h = await startZellijSixelApp(t)
  const jpeg = h.store.add({
    bytes: new Uint8Array(SAMPLE_JPEG),
    mediaType: 'image/jpeg',
    width: 120,
    height: 80,
    name: 'photo.jpg',
  })
  h.terminal.writes.length = 0
  h.terminal.sendInput(jpeg.placeholder)
  await until(() => paintedRasters(h.terminal).length > 0, 'the Draft JPEG raster')
  assert.ok(decodeSixel(paintedRasters(h.terminal).at(-1)!).width > 0)

  const webp = h.store.add({
    bytes: new Uint8Array(SAMPLE_WEBP),
    mediaType: 'image/webp',
    width: 120,
    height: 80,
    name: 'shot.webp',
  })
  h.terminal.writes.length = 0
  h.terminal.sendInput(webp.placeholder)
  await until(() => paintedRasters(h.terminal).length > 0, 'the Draft WebP raster')
  assert.ok(decodeSixel(paintedRasters(h.terminal).at(-1)!).width > 0)

  const ref = imageRef('att-ze04-jpeg', 'photo.jpg', 'image/jpeg')
  h.terminal.writes.length = 0
  h.app.setTranscript(transcriptOf(ref).messages())
  await until(() => paintedRasters(h.terminal).length > 0, 'the transcript JPEG raster')
  h.terminal.writes.length = 0
  h.app.openTranscriptImagePicker()
  await until(() => h.terminal.getViewport().join('\n').includes('Images · current transcript'), 'the image picker')
  h.terminal.sendInput('\r')
  await until(() => paintedRasters(h.terminal).length > 0, 'the Viewer raster')
  assert.ok(decodeSixel(paintedRasters(h.terminal).at(-1)!).width > 0)
})

// ── ZE05: the Assistant SVG thumbnail and Viewer Preview ──────────────────

test('ZE05: an Assistant SVG thumbnail and the SVG Viewer Preview paint through the same SIXEL owner', async (t) => {
  const h = await startZellijSixelApp(t)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="#3b82f6"/></svg>'
  h.app.setFullscreen(true)
  h.terminal.writes.length = 0
  h.app.setTranscript(assistantSvgVisual(svg).messages())
  h.app.requestRender()
  await until(() => h.terminal.getViewport().join('\n').includes('Service topology'), 'the Assistant SVG card')
  await until(() => paintedRasters(h.terminal).length > 0, 'the SVG thumbnail raster')
  const thumbnail = decodeSixel(paintedRasters(h.terminal).at(-1)!)
  assert.ok(thumbnail.width > 0 && thumbnail.height > 0)

  const handles = [...(h.app as unknown as {
    visualFigureHandles: Map<unknown, Map<string, unknown>>
  }).visualFigureHandles.values()].flatMap(byRef => [...byRef.values()])
  assert.equal(handles.length, 1)
  h.terminal.writes.length = 0
  ;(h.app as unknown as { openSvgViewer(handle: unknown): void }).openSvgViewer(handles[0])
  await until(() => paintedRasters(h.terminal).length > 0, 'the SVG Viewer Preview raster')
  assert.ok(decodeSixel(paintedRasters(h.terminal).at(-1)!).width > 0)

  h.terminal.writes.length = 0
  h.terminal.sendInput('\t')
  await settle(h.app, h.terminal)
  const sourceView = h.terminal.getViewport().join('\n')
  assert.ok(sourceView.includes('<svg') && sourceView.includes('<rect'), 'Source stays raw SVG text')
  assert.equal(paintedRasters(h.terminal).length, 0, 'the Source page paints no image')
})

// ── ZE06: resize and Main↔Alt keep one owner and no stale worker ───────────

test('ZE06: a resize and Main↔Alt round-trip re-sample the same Zellij SIXEL owner', async (t) => {
  const png = await pngFromRgba(fill(80, 40, () => [255, 0, 0, 255]), 80, 40)
  const h = await startZellijSixelApp(t)
  const image = h.store.add({ bytes: png, mediaType: 'image/png', width: 80, height: 40, name: 'red.png' })
  h.terminal.writes.length = 0
  h.terminal.sendInput(image.placeholder)
  await until(() => paintedRasters(h.terminal).length > 0, 'the pre-resize raster')

  h.terminal.writes.length = 0
  h.terminal.resize(100, 24)
  await until(() => h.terminal.writes.join('').includes('\x1b[16t'), 'the resize re-observation')
  await tick(300)
  assert.equal(h.graphics.selectedProtocol(), 'sixel', 'the resize re-query keeps SIXEL')
  await until(() => paintedRasters(h.terminal).length > 0, 'the post-resize raster')
  const resized = decodeSixel(paintedRasters(h.terminal).at(-1)!)
  assert.equal(resized.width, 80)

  h.terminal.writes.length = 0
  h.app.setFullscreen(true)
  await until(() => paintedRasters(h.terminal).length > 0, 'the Alt raster')
  h.terminal.writes.length = 0
  h.app.setFullscreen(false)
  await tick(300)
  assert.ok(!h.terminal.writes.join('').includes('SIXC'), 'no internal marker leaks after the screen swap')
})


/** A long transcript with one image in the middle; enough rows to show the auto scrollbar. */
function longTranscriptWithImage(ref: ImageAttachmentRefLike): TranscriptFolder {
  const folder = new TranscriptFolder()
  const events: unknown[] = []
  for (let index = 0; index < 32; index += 1) {
    events.push({
      type: 'user/message',
      seq: index + 1,
      time: index + 1,
      data: {
        content: index === 31
          ? [{ type: 'image', attachment: ref }]
          : [{ type: 'text', text: `ZE08 scroll row ${String(index + 1).padStart(2, '0')} — product transcript content.` }],
        source: { kind: 'user' },
      },
    })
  }
  folder.apply(events as never)
  return folder
}


// ── ZE08: a real auto scrollbar keeps a non-overlapping SIXEL image ───────

test('ZE08: an auto scrollbar keeps a non-overlapping Zellij SIXEL image visible', async (t) => {
  const h = await startZellijSixelApp(t)
  const ref = imageRef('att-ze08-scrollbar', 'scrollbar.png', 'image/png')
  h.app.setTranscript(longTranscriptWithImage(ref).messages())
  await until(() => h.reads.get(ref.attachmentId) === 1, 'the long transcript image read')
  h.terminal.writes.length = 0
  h.app.setFullscreen(true)
  await until(() => paintedRasters(h.terminal).length > 0, 'the fullscreen image raster')
  const before = paintedRasters(h.terminal).at(-1)!

  // Hover/scroll at the right edge is the real X074 mouse path; the auto
  // scrollbar becomes visible without touching the image's anchor column.
  h.terminal.sendInput(`\x1b[<35;${h.terminal.columns};1M`)
  h.terminal.sendInput(`\x1b[<64;${h.terminal.columns};1M`)
  await settle(h.app, h.terminal)
  const view = h.terminal.getViewport()
  assert.ok(view.some(line => line.trimEnd().endsWith('│') || line.trimEnd().endsWith('┃')), 'the auto scrollbar is visible')
  const after = paintedRasters(h.terminal).at(-1)
  assert.ok(after !== undefined, 'the image remains painted while the auto scrollbar is visible')
  const decoded = decodeSixel(after!)
  assert.ok(decoded.width > 0 && decoded.width < h.terminal.columns * 10, 'the image stays inside the non-overlapping column budget')
  assert.notEqual(h.graphics.sixelScreen.footprint(after!), undefined, 'the visible image is still a trusted raster')
  assert.equal(h.graphics.selectedProtocol(), 'sixel')
  assert.ok(before.length > 0)
})

// ── ZE11: hard-off and non-Zellij topologies never fall into SIXEL ────────

test('ZE11: PI_IMAGE_PROTOCOL=none and nested multiplexers create no negotiated SIXEL', async (t) => {
  for (const entry of [
    { name: 'none', PI_IMAGE_PROTOCOL: 'none' },
    { name: '0', PI_IMAGE_PROTOCOL: '0' },
    { name: 'iterm2', PI_IMAGE_PROTOCOL: 'iterm2' },
    { name: 'nested tmux', TMUX: '/tmp/tmux,1,0' },
    { name: 'nested screen', STY: 'screen-1' },
  ] as const) {
    await t.test(entry.name, async (st) => {
      const cli = createFakeZellijCli(st)
      const restore = applyEnvironment({
        ...cli.env,
        TERM: 'xterm-256color',
        ZELLIJ: '0',
        ...entry,
      })
      try {
        const terminal = new ZellijSixelAppTerminal(100, 24)
        const app = new TuiApp(terminal, { onSubmit: () => {}, onExit: () => {} })
        st.after(() => app.dispose())
        app.start()
        const graphics = (app as unknown as { graphics: ImageGraphics | undefined }).graphics
        assert.equal(graphics, undefined, `${entry.name}: no managed graphics handle`)
        assert.equal(terminal.writes.join('').includes('a=q,'), false, `${entry.name}: no live probe`)
      } finally {
        restore()
      }
    })
  }
})


// ── ZE09b: a real revoke clears the product click body ─────────────────────

test('ZE09b: a real DA1 revoke clears the Zellij image body and click footprint', async (t) => {
  const h = await startZellijSixelApp(t)
  const ref = imageRef('att-ze09b-ghost', 'ghost.png', 'image/png')
  h.app.setTranscript(transcriptOf(ref).messages())
  await until(() => h.reads.get(ref.attachmentId) === 1, 'the image read')
  h.app.setFullscreen(true)
  await until(() => paintedRasters(h.terminal).length > 0, 'the fullscreen raster')
  const internals = h.app as unknown as {
    mountedImageOccurrences(): { thumbnail: { paintedImageBody(width: number): { rows: number; endCol: number } | undefined } }[]
    transcriptRenderWidth(): number
  }
  const width = internals.transcriptRenderWidth()
  assert.ok(internals.mountedImageOccurrences()[0]?.thumbnail.paintedImageBody(width) !== undefined,
    'the committed image has a real click body before revoke')
  const oldDcs = paintedRasters(h.terminal).at(-1)!
  assert.notEqual(h.graphics.sixelScreen.footprint(oldDcs), undefined, 'the old raster is trusted before revoke')
  h.terminal.writes.length = 0
  h.terminal.declareDa1(false)
  await until(() => h.graphics.selectedProtocol() === null, 'the one-way revoke')
  await tick(300)
  assert.equal(internals.mountedImageOccurrences()[0]?.thumbnail.paintedImageBody(width), undefined,
    'the revoked image has no ghost click body')
  assert.equal(effectiveImageProtocol(h.graphics), null)
  assert.equal(h.graphics.sixelScreen.footprint(oldDcs), undefined, 'the old footprint is erased')
  assert.equal(paintedRasters(h.terminal).length, 0, 'the text repaint emits no old DCS')
})

// ── ZE10: a revoke during an in-flight encode leaves no raster ─────────────

test('ZE10: a revoke during an in-flight Zellij encode registers no raster after settle', async (t) => {
  const noise = await pngFromRgba(fill(800, 600, (x, y) => {
    const n = (x * 7 + y * 13) % 256
    return [(n * 37) & 255, (n * 97) & 255, (n * 131) & 255, 255]
  }), 800, 600)
  const loader = new ImageLoader(async () => ({ ref: {}, data: noise }))
  const h = await startZellijSixelApp(t, { imageLoader: loader, cellWidthPx: 20, cellHeightPx: 40 })
  const ref: ImageAttachmentRefLike = {
    attachmentId: 'att-ze10-noise',
    mediaType: 'image/png',
    bytes: noise.byteLength,
    width: 800,
    height: 600,
    name: 'noise.png',
  }
  h.terminal.writes.length = 0
  h.app.setTranscript(transcriptOf(ref).messages())
  h.app.requestRender()
  await tick(40)
  h.terminal.declareDa1(false)
  await until(() => h.graphics.selectedProtocol() === null, 'the one-way revoke')
  await tick(600)
  assert.equal(paintedRasters(h.terminal).length, 0, 'no stale raster reached the sink')
  assert.equal(h.graphics.canPaint(), false)
})
