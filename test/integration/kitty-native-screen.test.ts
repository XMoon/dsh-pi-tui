/**
 * Image-7A PR1 — the managed Core behind the REAL fork screens.
 *
 * These cases mount the actual `TuiMainScreen` / `TuiAltScreen` writer (the
 * production frame/diff/scrollback owner) and parse the bytes it produced, so
 * a passing case proves the gate and the writer agree: what the screen thinks
 * it deleted, what actually reached the terminal, and which side was allowed
 * to free the data.
 * @module @xmoon76/dsh-pi-tui/integration/kitty-native-screen.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TuiAltScreen,
  TuiMainScreen,
  getCapabilities,
  resetCapabilitiesCache,
  setCapabilities,
  setCapabilityOverrides,
  type Component,
  type Terminal,
  type TerminalProgressState,
} from '@xmoon76/pi-tui'
import {
  Container as LegacyContainer,
  Image as LegacyImage,
  ScrollView as LegacyScrollView,
  Text as LegacyText,
} from '@xmoon76/pi-tui'
import { ImageThumbnail } from '../../src/tui/components/media/image-thumbnail.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { ImageCache } from '../../src/client/media/image/cache.ts'
import { convertKittyThumbnail } from '../../src/client/media/image/kitty-thumbnail.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'
import { KittyGraphicsCore } from '../../src/tui/graphics/kitty-core.ts'
import { parseKittyApc } from '../../src/tui/graphics/kitty-native.ts'
import { KITTY_VIRTUAL_PLACEHOLDER } from '../../src/tui/graphics/tmux-virtual.ts'
import { KittyTerminalFacade } from '../../src/tui/graphics/kitty-terminal.ts'
import { NativeKittyImage } from '../../src/tui/graphics/native-image.ts'
import type { KittyGraphics } from '../../src/tui/graphics/native-image.ts'
import type { ZellijNegotiatedGraphics } from '../../src/tui/graphics/zellij-sixel.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

class RecordingTerminal implements Terminal {
  readonly writes: string[] = []
  columns = 100
  rows = 40
  kittyProtocolActive = false
  /** When set, the matching write throws AFTER recording the bytes. */
  failWhen: ((data: string) => boolean) | undefined

  get text(): string {
    return this.writes.join('')
  }

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data)
    if (this.failWhen?.(data) === true) {
      this.failWhen = undefined
      throw new Error('terminal write failed')
    }
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

interface Apc {
  readonly offset: number
  readonly a: string | undefined
  readonly i: string | undefined
  readonly d: string | undefined
  readonly c: string | undefined
  readonly r: string | undefined
  readonly q: string | undefined
}

function apcs(text: string): Apc[] {
  const found: Apc[] = []
  let index = 0
  for (;;) {
    const start = text.indexOf('\x1b_G', index)
    if (start === -1) break
    const end = text.indexOf('\x1b\\', start + 3)
    if (end === -1) break
    const command = parseKittyApc(text.slice(start, end + 2))
    if (command !== undefined) {
      found.push({
        offset: start,
        a: command.controls.a,
        i: command.controls.i,
        d: command.controls.d,
        c: command.controls.c,
        r: command.controls.r,
        q: command.controls.q,
      })
    }
    index = end + 2
  }
  return found
}

function setup() {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const terminal = new RecordingTerminal()
  const core = new KittyGraphicsCore()
  const facade = new KittyTerminalFacade(terminal, core)
  return { terminal, core, facade }
}

class Root implements Component {
  showA = true
  status = 0
  readonly imageA: NativeKittyImage

  constructor(core: KittyGraphicsCore, widthPx = 64, heightPx = 64) {
    this.imageA = new NativeKittyImage(
      core,
      { pngBase64: PNG, widthPx, heightPx },
      { maxWidthCells: 30, maxHeightCells: 10, fallback: '[fallback]' },
    )
  }

  render(width: number): string[] {
    const lines = ['title', `width=${width}`]
    if (this.showA) lines.push('', ...this.imageA.render(width))
    for (let index = 0; index < this.status; index++) lines.push(`status ${index}`)
    lines.push('END')
    return lines
  }

  invalidate(): void {
    this.imageA.invalidate()
  }

  dispose(): void {
    this.imageA.dispose()
  }
}

test('main screen: first paint uploads once, then only placements', () => {
  const { terminal, core, facade } = setup()
  const root = new Root(core)
  const screen = new TuiMainScreen(facade)
  screen.addChild(root)
  screen.start()
  terminal.writes.length = 0
  screen.renderNow()

  const first = apcs(terminal.text)
  assert.equal(first.filter((entry) => entry.a === 't').length, 1, 'one transmission')
  assert.equal(first.filter((entry) => entry.a === 'p').length, 1, 'one placement')
  assert.ok(first.findIndex((entry) => entry.a === 't') < first.findIndex((entry) => entry.a === 'p'))
  assert.ok(first.every((entry) => entry.q === '2'), 'every graphics command is quiet')
  assert.equal(root.imageA.paintedBodyAt(100)?.rows, 10, 'the anchor reserves its real rows')

  terminal.writes.length = 0
  root.status = 1
  screen.renderNow()
  const second = apcs(terminal.text)
  assert.equal(second.filter((entry) => entry.a === 't').length, 0, 'a steady frame never re-transmits')
  screen.stop()
})

test('main screen: hide removes the placement in that frame, show re-places without a re-upload', () => {
  const { terminal, core, facade } = setup()
  const root = new Root(core)
  const screen = new TuiMainScreen(facade)
  screen.addChild(root)
  screen.start()
  screen.renderNow()
  const imageId = root.imageA.imageId
  assert.ok(imageId !== undefined)

  terminal.writes.length = 0
  root.showA = false
  screen.renderNow()
  const hidden = apcs(terminal.text)
  assert.ok(
    hidden.some((entry) => entry.a === 'd' && entry.d === 'i' && entry.i === String(imageId)),
    'the writer-issued delete became a scoped placement removal',
  )
  assert.ok(!hidden.some((entry) => entry.a === 'd' && entry.d === 'I'), 'the writer never frees the data')
  assert.ok(!hidden.some((entry) => entry.a === 'p'), 'no placement for a hidden image')

  terminal.writes.length = 0
  root.showA = true
  screen.renderNow()
  const shown = apcs(terminal.text)
  assert.equal(shown.filter((entry) => entry.a === 'p').length, 1, 'the image comes straight back')
  assert.equal(shown.filter((entry) => entry.a === 't').length, 0, 'with no re-transmission')
  screen.stop()
})

test('main screen: a full redraw re-transmits after its clear and before its placement', () => {
  const { terminal, core, facade } = setup()
  const root = new Root(core)
  const screen = new TuiMainScreen(facade)
  screen.addChild(root)
  screen.start()
  screen.renderNow()

  terminal.writes.length = 0
  terminal.columns = 60
  screen.renderNow()
  const text = terminal.text
  const clear2 = text.indexOf('\x1b[2J')
  const clear3 = text.indexOf('\x1b[3J')
  const transmit = text.indexOf('a=t,f=100')
  const place = text.indexOf('a=p,')
  assert.ok(clear2 !== -1 && clear3 !== -1, 'the full redraw really clears')
  assert.ok(transmit > clear3, 'the payload is re-sent after the last invalidating clear')
  assert.ok(place > transmit, 'and before the placement')
  screen.stop()
})

test('a screen stop never destroys a registration a live component still holds', () => {
  const { terminal, core, facade } = setup()
  // Rendered (so the id is registered) but never written to the terminal — the
  // occurrence is still owned by a live component.
  const root = new Root(core)
  const screen = new TuiMainScreen(facade)
  screen.addChild(root)
  const anchor = root.imageA.render(100)
  assert.ok(anchor.length > 1, 'the occurrence registered and painted lines')
  const imageId = root.imageA.imageId!

  terminal.writes.length = 0
  screen.start()
  screen.stop()
  assert.equal(core.owns(imageId), true, 'the stop kept the live registration')
  assert.ok(!terminal.text.includes('a=d'), 'and sent no delete for it')

  // The screen comes back and the SAME component re-renders its cached lines.
  screen.start()
  terminal.writes.length = 0
  screen.renderNow()
  const commands = apcs(terminal.text)
  assert.equal(commands.filter((entry) => entry.a === 't').length, 1, 'the payload is sent on the first real placement')
  assert.ok(commands.findIndex((entry) => entry.a === 't') < commands.findIndex((entry) => entry.a === 'p'))
  screen.stop()
})

test('alt screen: foreign and managed deletes stay isolated in both directions', () => {
  const { terminal, core, facade } = setup()
  const root = new Root(core)
  const screen = new TuiAltScreen(facade, undefined, undefined, { mouse: false })
  screen.addChild(root)
  screen.start()
  screen.renderNow()
  const managedId = root.imageA.imageId!
  const foreignId = 0x1234abcd

  // A foreign owner's own image, emitted through the same facade.
  facade.write(`\x1b[12;1H\x1b_Ga=T,f=100,q=2,i=${foreignId},p=7,c=6,r=3,C=1;${PNG}\x1b\\`)
  terminal.writes.length = 0

  // 1) The foreign owner deletes its own image: byte-identical pass-through.
  facade.write(`\x1b_Ga=d,d=I,i=${foreignId},q=2\x1b\\`)
  assert.equal(terminal.text, `\x1b_Ga=d,d=I,i=${foreignId},q=2\x1b\\`)

  // 2) The alternate screen's own exit releases ONLY what it placed; the
  //    foreign owner and every other buffer are never mentioned.
  terminal.writes.length = 0
  screen.stop()
  const text = terminal.text
  assert.ok(text.includes(`a=d,d=I,i=${managedId}`), 'the alt-owned id is released')
  assert.ok(!text.includes(`i=${foreignId}`), 'the foreign id is never mentioned')
  assert.ok(!text.includes('d=A') && !text.includes('d=a'), 'no global delete reaches the terminal')
})

test('alt screen: the global release at stop becomes scoped own-id deletes', () => {
  const { terminal, core, facade } = setup()
  const root = new Root(core)
  const screen = new TuiAltScreen(facade, undefined, undefined, { mouse: false })
  screen.addChild(root)
  screen.start()
  screen.renderNow()
  const imageId = root.imageA.imageId!
  terminal.writes.length = 0
  screen.stop()
  const text = terminal.text
  assert.ok(text.includes(`a=d,d=I,i=${imageId}`), 'the own image is released')
  assert.ok(!text.includes('d=A') && !text.includes('d=a'), 'the global form never reaches the terminal')
})

test('the real transcript thumbnail paints through the managed Core', async () => {
  const { terminal, core, facade } = setup()
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const loader = new ImageLoader(async () => ({ ref: {}, data: bytes }))
  const ref = { attachmentId: 'att-1', mediaType: 'image/png' as const, bytes: 96, width: 64, height: 64, name: 'shot.png' }
  loader.load(ref)
  const graphics: KittyGraphics = {
    mode: 'native',
    canPaint: () => true,
    image: (source, options) => new NativeKittyImage(core, source, options),
    terminal: facade,
    dispose: () => {},
  }
  const screen = new TuiMainScreen(facade)
  const cache: ImageThumbnail[] = []
  class Thumbnails implements Component {
    render(width: number): string[] {
      if (cache.length === 0) {
        cache.push(new ImageThumbnail(
          ref,
          loader,
          { fallbackColor: (text: string) => text },
          () => {},
          undefined,
          undefined,
          undefined,
          graphics,
        ))
      }
      return cache[0]!.render(width)
    }
    invalidate(): void {
      for (const thumbnail of cache) thumbnail.invalidate()
    }
  }
  screen.addChild(new Thumbnails())
  screen.start()
  // First frame: the read is fired and the info row is painted. The settle
  // invalidates the component; the next frame is the one that paints pixels.
  screen.renderNow()
  await new Promise((resolve) => setTimeout(resolve, 25))
  terminal.writes.length = 0
  screen.renderNow()

  const commands = apcs(terminal.text)
  assert.equal(commands.filter((entry) => entry.a === 't').length, 1, 'one managed upload')
  const placement = commands.find((entry) => entry.a === 'p')
  assert.ok(placement !== undefined, 'the managed placement is written')
  const body = cache[0]!.paintedImageBody(100)
  assert.ok(body !== undefined, 'the component registered a real pixel body')
  assert.equal(body.endCol, Number(placement.c), 'the click band equals the painted placement width')
  assert.equal(body.rows, Number(placement.r), 'and the painted rows')
  assert.ok(cache[0]!.render(100).join('\n').includes('🖼️ shot.png'), 'the info row is unchanged')
  screen.stop()
})


/**
 * The wiring proof: a REAL `TuiApp` on a terminal that admits the managed path
 * must route the real main screen through the facade. Without that wiring the
 * transcript image falls back to the fork's combined `a=T` form and no
 * ownership contract is enforced at all.
 */
test('TuiApp routes the real main screen through the managed facade', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const saved: Record<string, string | undefined> = {}
  for (const key of ['KITTY_WINDOW_ID', 'TERM_PROGRAM', 'TMUX', 'ZELLIJ', 'STY', 'TERM']) {
    saved[key] = process.env[key]
  }
  process.env.KITTY_WINDOW_ID = '3'
  process.env.TERM_PROGRAM = 'kitty'
  process.env.TERM = 'xterm-kitty'
  for (const key of ['TMUX', 'ZELLIJ', 'STY']) delete process.env[key]
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: new ImageLoader(async () => ({
      ref: {},
      data: Buffer.from(PNG, 'base64'),
    })),
    imageTheme: { fallbackColor: (text: string) => text },
  })
  app.start()
  try {
    const folder = new TranscriptFolder()
    folder.apply([{
      type: 'user/message',
      seq: 1,
      time: 1,
      data: {
        content: [{
          type: 'image',
          attachment: { attachmentId: 'att-wire', mediaType: 'image/png', bytes: 68, width: 64, height: 64, name: 'wire.png' },
        }],
        source: { kind: 'user' },
      },
    }] as never)
    app.setTranscript(folder.messages())
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      await vt.waitForRender()
    }
    const text = vt.writes.join('')
    assert.ok(text.includes('a=t,f=100'), 'the managed transmission reached the screen writer')
    assert.ok(text.includes('a=p,'), 'the managed placement reached the screen writer')
    assert.ok(!text.includes('a=T,'), 'the legacy combined transmit+place form was not used')
    assert.ok(!text.includes('d=A') && !text.includes('d=a'), 'no global delete was emitted')
  } finally {
    app.dispose()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})


/**
 * Image-7C-2/7C — the Direct Native product path.
 *
 * These cases set the REAL process environment and let the fork's own
 * `detectCapabilities()` classify it: no `setCapabilities` shortcut is used,
 * because a hand-set cache would only prove the classifier, not the source
 * (environment) → decision (admission) → sink (TuiApp screens) chain.
 *
 * The tmux-virtual fallback is disabled (`PI_TUI_TMUX_KITTY_IMAGES=0`) in these
 * cases: Image-7C-1 owns that transport's live-server admission, and the native
 * factory is evaluated BEFORE that fallback either way.
 */
const NATIVE_ENV_KEYS = [
  'TERM',
  'TERM_PROGRAM',
  'KITTY_WINDOW_ID',
  'GHOSTTY_RESOURCES_DIR',
  'WEZTERM_PANE',
  'WARP_SESSION_ID',
  'WARP_TERMINAL_SESSION_UUID',
  'TMUX',
  'ZELLIJ',
  'STY',
  'PI_IMAGE_PROTOCOL',
  'PI_TUI_TMUX_KITTY_IMAGES',
] as const

/** Apply EXACTLY one environment through the real detection path; returns its restorer. */
function applyGhosttyEnvironment(environment: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>()
  for (const key of NATIVE_ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[key] = value
  }
  setCapabilityOverrides({})
  resetCapabilitiesCache()
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    setCapabilityOverrides({})
    resetCapabilitiesCache()
  }
}

/** A bounded event wait, not a wall-clock guess. */
async function untilFact(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** Let the throttled frame pipeline settle, awaiting each rendered frame. */
async function settleApp(app: TuiApp, vt: VirtualTerminal): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    app.requestRender()
    await new Promise((resolve) => setTimeout(resolve, 15))
    await vt.waitForRender()
  }
}

interface CountingLoader {
  readonly loader: ImageLoader
  readonly reads: Map<string, number>
  readonly conversions: { count: number }
}

/** A REAL ImageLoader whose read/conversion boundaries are counted. */
function countingLoader(): CountingLoader {
  const reads = new Map<string, number>()
  const conversions = { count: 0 }
  const loader = new ImageLoader(
    async (ref) => {
      reads.set(ref.attachmentId, (reads.get(ref.attachmentId) ?? 0) + 1)
      return { ref: {}, data: Buffer.from(PNG, 'base64') }
    },
    new ImageCache(),
    async (input, mediaType) => {
      conversions.count += 1
      return convertKittyThumbnail(input, mediaType)
    },
  )
  return { loader, reads, conversions }
}

function transcriptOfImage(ref: ImageAttachmentRefLike): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.apply([{
    type: 'user/message',
    seq: 1,
    time: 1,
    data: { content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } },
  }] as never)
  return folder
}

function ghosttyImageRef(attachmentId: string, name: string): ImageAttachmentRefLike {
  return {
    attachmentId,
    mediaType: 'image/png',
    bytes: Buffer.from(PNG, 'base64').byteLength,
    width: 64,
    height: 64,
    name,
  }
}

test('direct Ghostty reaches the Native Core through the real environment and TuiApp', async (t) => {
  const apps = createAppLifecycleGuard<TuiApp>()
  t.after(() => apps.disposeAll())
  for (const term of ['xterm-ghostty', 'xterm-256color'] as const) {
    await t.test(`TERM=${term}`, async () => {
      const restore = applyGhosttyEnvironment({
        TERM_PROGRAM: 'ghostty',
        TERM: term,
        PI_TUI_TMUX_KITTY_IMAGES: '0',
      })
      try {
        assert.equal(getCapabilities().images, 'kitty', 'the fork really classified the detected Ghostty environment')
        const { loader, reads, conversions } = countingLoader()
        const vt = new VirtualTerminal(100, 30)
        const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
          imageLoader: loader,
          imageTheme: { fallbackColor: (text: string) => text },
        })
        app.start()
        apps.started.add(app)
        try {
          const graphics = (app as unknown as { graphics: KittyGraphics | undefined }).graphics
          assert.ok(graphics, 'the production composition created the managed handle')
          assert.equal(graphics.mode, 'native', 'direct Ghostty is the native transport, not tmux-virtual')
          assert.equal(graphics.canPaint(), true)
          assert.equal((app as unknown as { terminal: unknown }).terminal, graphics.terminal,
            'the ONE facade is the terminal both screens write through')

          const ref = ghosttyImageRef(`att-ghostty-${term}`, `wire-${term}.png`)
          const folder = transcriptOfImage(ref)
          app.setTranscript(folder.messages())
          await untilFact(() => loader.get(ref).state === 'ready', 'the real durable PNG read')
          await settleApp(app, vt)

          const text = vt.writes.join('')
          assert.equal(reads.get(ref.attachmentId), 1, 'the durable attachment was read once')
          assert.equal(conversions.count, 0, 'a PNG needs no derived conversion')
          assert.equal(text.includes('\x1bPtmux;'), false, 'Ghostty never travels inside tmux passthrough')
          assert.equal(text.includes(',U=1'), false, 'no virtual placeholder flag')
          assert.equal(text.includes(KITTY_VIRTUAL_PLACEHOLDER), false, 'no virtual placeholder cell')
          assert.equal(text.includes('a=T,'), false, 'no legacy combined transmit+place form')
          assert.equal(text.includes('d=A') || text.includes('d=a'), false, 'no global delete')

          const upload = apcs(text).filter((entry) => entry.a === 't')
          const placements = apcs(text).filter((entry) => entry.a === 'p')
          assert.equal(upload.length, 1, 'one managed upload')
          assert.equal(placements.length, 1, 'one managed placement')
          assert.ok(text.indexOf('a=t,f=100') < text.indexOf('a=p,'), 'the upload precedes the placement')
          assert.equal(placements[0]!.i, upload[0]!.i, 'the placement names the uploaded image')

          const scrollView = vt.getScrollBuffer().join('\n')
          assert.ok(scrollView.includes(`🖼️ wire-${term}.png`), `the identity row is painted:\n${scrollView}`)
          assert.ok(scrollView.includes('64×64 · 70 B'), `the info row reports the real dimensions and bytes:\n${scrollView}`)

          const internals = app as unknown as {
            mountedImageOccurrences(): { thumbnail: { paintedImageBody(width: number): { rows: number; endCol: number } | undefined } }[]
            transcriptRenderWidth(): number
          }
          const body = internals.mountedImageOccurrences()[0]?.thumbnail.paintedImageBody(internals.transcriptRenderWidth())
          assert.ok(body !== undefined, 'the occurrence registered a real clickable body')
          assert.equal(Number(placements[0]!.c), body.endCol, 'the body width equals the painted placement width')
          assert.equal(Number(placements[0]!.r), body.rows, 'the body rows equal the painted placement rows')

          // The real pointer route proves the body data is what opens the Viewer.
          app.setFullscreen(true)
          await settleApp(app, vt)
          const rows = await vt.flushAndGetViewport()
          const infoRow = rows.findIndex((row) => row.includes('64×64 · 70 B'))
          assert.ok(infoRow >= 0, `the fullscreen info row is on screen:\n${rows.join('\n')}`)
          // The fullscreen transcript may re-derive its width, so the click
          // column comes from the body the fullscreen frame really painted.
          const fullscreenBody = internals.mountedImageOccurrences()[0]?.thumbnail
            .paintedImageBody(internals.transcriptRenderWidth())
          assert.ok(fullscreenBody !== undefined, 'the fullscreen occurrence registered a real clickable body')
          const clickColumn = Math.max(1, Math.min(4, fullscreenBody.endCol))
          vt.sendInput(`\x1b[<0;${clickColumn};${infoRow + 2}M`)
          vt.sendInput(`\x1b[<0;${clickColumn};${infoRow + 2}m`)
          await settleApp(app, vt)
          const viewer = vt.getViewport().join('\n')
          assert.ok(viewer.includes('Esc'), `the Viewer painted its own chrome:\n${viewer}`)
          assert.ok(viewer.includes(`Image · wire-${term}.png`), `the Viewer opened on the real body:\n${viewer}`)
          assert.equal(reads.get(ref.attachmentId), 1, 'the Viewer re-read no durable bytes')
          vt.sendInput('\x1b')
          await settleApp(app, vt)
          assert.equal(vt.getViewport().join('\n').includes(`Image · wire-${term}.png`), false, 'Esc restored the transcript')
          app.setFullscreen(false)
          await settleApp(app, vt)
        } finally {
          app.dispose()
          apps.started.delete(app)
        }
      } finally {
        restore()
      }
    })
  }
})

test('direct WezTerm, Warp, Tern fallback and explicit Kitty override paint through the real TuiApp Native path', async (t) => {
  const apps = createAppLifecycleGuard<TuiApp>()
  t.after(() => apps.disposeAll())
  const hosts = [
    { name: 'WezTerm', environment: { TERM_PROGRAM: 'wezterm', WEZTERM_PANE: '4' } },
    { name: 'Warp', environment: { TERM_PROGRAM: 'warpterminal', WARP_SESSION_ID: 'warp-1' } },
    { name: 'Tern PiTui fallback', environment: { TERM_PROGRAM: 'tern' } },
    { name: 'unknown terminal with PI_IMAGE_PROTOCOL=kitty', environment: { PI_IMAGE_PROTOCOL: 'kitty' } },
  ] as const
  for (const [index, host] of hosts.entries()) {
    await t.test(host.name, async () => {
      const restore = applyGhosttyEnvironment({
        ...host.environment,
        TERM: 'xterm-256color',
        PI_TUI_TMUX_KITTY_IMAGES: '0',
      })
      try {
        assert.equal(getCapabilities().images, 'kitty', `${host.name}: the fork really detects the Kitty capability`)
        const { loader, reads, conversions } = countingLoader()
        const vt = new VirtualTerminal(100, 30)
        const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
          imageLoader: loader,
          imageTheme: { fallbackColor: (text: string) => text },
        })
        app.start()
        apps.started.add(app)
        try {
          const graphics = (app as unknown as { graphics: KittyGraphics | undefined }).graphics
          assert.ok(graphics, `${host.name}: the production composition created the managed handle`)
          assert.equal(graphics.mode, 'native', `${host.name}: the native transport, not tmux-virtual`)
          assert.equal(graphics.canPaint(), true)
          assert.equal((app as unknown as { terminal: unknown }).terminal, graphics.terminal,
            `${host.name}: the ONE facade is the terminal both screens write through`)

          const ref = ghosttyImageRef(`att-direct-${index}`, `wire-${index}.png`)
          app.setTranscript(transcriptOfImage(ref).messages())
          await untilFact(() => loader.get(ref).state === 'ready', `${host.name}: the real durable PNG read`)
          await settleApp(app, vt)

          const text = vt.writes.join('')
          assert.equal(reads.get(ref.attachmentId), 1, `${host.name}: the attachment was read once`)
          assert.equal(conversions.count, 0, `${host.name}: a PNG needs no derived conversion`)
          assert.equal(text.includes('a=T,'), false, `${host.name}: no legacy combined transmit+place form`)
          assert.equal(text.includes('\x1bPtmux;'), false, `${host.name}: no tmux passthrough`)
          assert.equal(text.includes(',U=1'), false, `${host.name}: no virtual placeholder flag`)
          assert.equal(text.includes(KITTY_VIRTUAL_PLACEHOLDER), false, `${host.name}: no virtual placeholder cell`)
          const uploads = apcs(text).filter((entry) => entry.a === 't')
          const placements = apcs(text).filter((entry) => entry.a === 'p')
          assert.equal(uploads.length, 1, `${host.name}: one managed upload`)
          assert.equal(placements.length, 1, `${host.name}: one managed placement`)
          assert.ok(text.indexOf('a=t,f=100') < text.indexOf('a=p,'), `${host.name}: upload precedes placement`)
          assert.equal(placements[0]!.i, uploads[0]!.i, `${host.name}: the placement names the uploaded image`)
        } finally {
          app.dispose()
          apps.started.delete(app)
        }
      } finally {
        restore()
      }
    })
  }
})

test('a ZELLIJ session routes TuiApp to the Zellij query factory, never the Direct path', async (t) => {
  const apps = createAppLifecycleGuard<TuiApp>()
  t.after(() => apps.disposeAll())
  const restore = applyGhosttyEnvironment({
    TERM_PROGRAM: 'ghostty',
    TERM: 'xterm-256color',
    ZELLIJ: '1',
    PI_TUI_TMUX_KITTY_IMAGES: '0',
  })
  try {
    assert.equal(getCapabilities().images, 'kitty', 'the inherited host capability is not the admission fact')
    const { loader, reads } = countingLoader()
    const vt = new VirtualTerminal(100, 30)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
      imageLoader: loader,
      imageTheme: { fallbackColor: (text: string) => text },
    })
    app.start()
    apps.started.add(app)
    try {
      const graphics = (app as unknown as { graphics: ZellijNegotiatedGraphics | undefined }).graphics
      assert.ok(graphics, 'the Zellij factory created one pending handle')
      assert.equal(graphics.mode, 'zellij-negotiated')
      assert.equal(graphics.canPaint(), false, 'the pending admission paints no pixels')
      assert.equal((vt.writes.join('').match(/a=q,i=\d+/g) ?? []).length, 1, 'one live query after the real input listener')
      const ref = ghosttyImageRef('att-zellij-route', 'routed.png')
      app.setTranscript(transcriptOfImage(ref).messages())
      await settleApp(app, vt)
      const wire = vt.writes.join('')
      assert.equal(reads.get(ref.attachmentId), undefined, 'no payload read while the probe is pending')
      assert.equal(wire.includes('a=t,f=100') || wire.includes('a=p,'), false, 'no managed image before the OK')
      assert.equal(wire.includes('a=T,'), false, 'no legacy image before the OK')
    } finally {
      app.dispose()
      apps.started.delete(app)
    }
  } finally {
    restore()
  }
})

test('PI_IMAGE_PROTOCOL=none closes the real Ghostty path before any read or APC', async (t) => {
  const apps = createAppLifecycleGuard<TuiApp>()
  t.after(() => apps.disposeAll())
  const restore = applyGhosttyEnvironment({
    TERM_PROGRAM: 'ghostty',
    TERM: 'xterm-256color',
    PI_IMAGE_PROTOCOL: 'none',
    PI_TUI_TMUX_KITTY_IMAGES: '0',
  })
  try {
    assert.equal(getCapabilities().images, null, 'the real hard opt-out zeroes the fork capability')
    const { loader, reads, conversions } = countingLoader()
    const vt = new VirtualTerminal(100, 30)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
      imageLoader: loader,
      imageTheme: { fallbackColor: (text: string) => text },
    })
    app.start()
    apps.started.add(app)
    try {
      assert.equal((app as unknown as { graphics: KittyGraphics | undefined }).graphics, undefined,
        'no managed handle exists under the real hard opt-out')
      const ref = ghosttyImageRef('att-ghostty-none', 'none.png')
      app.setTranscript(transcriptOfImage(ref).messages())
      await settleApp(app, vt)
      const text = vt.writes.join('')
      assert.equal(reads.get(ref.attachmentId), undefined, 'no payload byte was read')
      assert.equal(conversions.count, 0, 'no conversion ran')
      assert.equal(text.includes('\x1b_G'), false, 'no Kitty APC at all')
      assert.equal(text.includes('\x1bPtmux;'), false, 'no tmux passthrough')
      assert.equal(text.includes('\x1b]1337;File='), false, 'no iTerm2 image sequence')
      assert.equal(text.includes(KITTY_VIRTUAL_PLACEHOLDER), false, 'no placeholder cell')
      const view = vt.getScrollBuffer().join('\n')
      assert.ok(view.includes('🖼️ none.png'), `the text identity row still paints:\n${view}`)
      assert.ok(view.includes('64×64 · 70 B'), `the text info row still reports the attachment facts:\n${view}`)
    } finally {
      app.dispose()
      apps.started.delete(app)
    }
  } finally {
    restore()
  }
})

test('the same TuiApp composition keeps explicit multiplexer transports out of the Direct path', async (t) => {
  const apps = createAppLifecycleGuard<TuiApp>()
  t.after(() => apps.disposeAll())
  const cases = [
    {
      label: 'Ghostty under tmux',
      environment: { TERM_PROGRAM: 'ghostty', TERM: 'xterm-256color', TMUX: '/tmp/tmux-1000/default,1,0' },
      capability: null,
    },
    {
      label: 'a tmux-named TERM without a direct pane',
      environment: { TERM_PROGRAM: 'ghostty', TERM: 'tmux-256color' },
      capability: null,
    },
    {
      label: 'a screen-named TERM without a direct pane',
      environment: { TERM_PROGRAM: 'ghostty', TERM: 'screen-256color' },
      capability: null,
    },
  ] as const
  for (const [index, entry] of cases.entries()) {
    const restore = applyGhosttyEnvironment({ ...entry.environment, PI_TUI_TMUX_KITTY_IMAGES: '0' })
    try {
      assert.equal(getCapabilities().images, entry.capability, `${entry.label}: the fork capability fact`)
      const { loader } = countingLoader()
      const vt = new VirtualTerminal(100, 30)
      const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
        imageLoader: loader,
        imageTheme: { fallbackColor: (text: string) => text },
      })
      app.start()
      apps.started.add(app)
      try {
        assert.equal((app as unknown as { graphics: KittyGraphics | undefined }).graphics, undefined,
          `${entry.label}: no managed native handle`)
        const ref = ghosttyImageRef(`att-negative-${index}`, 'rejected.png')
        app.setTranscript(transcriptOfImage(ref).messages())
        await settleApp(app, vt)
        const text = vt.writes.join('')
        assert.equal(/a=q,i=\d+/.test(text), false, `${entry.label}: no Zellij probe may run`)
        assert.equal(text.includes('a=t,f=100'), false, `${entry.label}: no managed transmission`)
        assert.equal(text.includes('a=p,'), false, `${entry.label}: no managed placement`)
      } finally {
        app.dispose()
        apps.started.delete(app)
      }
    } finally {
      restore()
    }
  }
})

/**
 * The Owner's amended budget (2026-10-27): a new image may never be refused
 * because of how many images the session already DISPLAYED. The main screen
 * keeps its scrollback, so id growth is terminal-retained and the Core only
 * bounds its own active working set.
 */
test('a real screen paints the 33rd, 64th and 100th thumbnail without a fallback', () => {
  const { terminal, core, facade } = setup()
  class Swapping implements Component {
    current: NativeKittyImage | undefined
    renders = 0
    render(width: number): string[] {
      this.renders += 1
      return ['head', '', ...(this.current?.render(width) ?? []), 'tail']
    }
    invalidate(): void {
      this.current?.invalidate()
    }
  }
  const root = new Swapping()
  const screen = new TuiMainScreen(facade)
  screen.addChild(root)
  screen.start()
  const painted: number[] = []
  for (let index = 0; index < 100; index++) {
    root.current?.dispose()
    root.current = new NativeKittyImage(core, { pngBase64: PNG, widthPx: 32, heightPx: 32 }, {
      maxWidthCells: 20,
      maxHeightCells: 6,
      fallback: '[FALLBACK]',
    })
    terminal.writes.length = 0
    screen.renderNow()
    const wire = terminal.text
    assert.ok(!wire.includes('[FALLBACK]'), `occurrence ${index + 1} painted pixels, not the fallback`)
    const placement = wire.lastIndexOf('a=p,')
    assert.ok(placement !== -1, `occurrence ${index + 1} was placed`)
    painted.push(root.current.imageId!)
  }
  assert.equal(new Set(painted).size, 100, 'every occurrence got its own id')
  const ids = apcs(terminal.text)
  assert.equal(ids.filter((entry) => entry.a === 'p').length, 1, 'one placement in the final frame')
  screen.stop()
})


/**
 * External review (PR #431) Finding 2: the vendored layout engine crops a kitty
 * placement at the viewport edges only for an id it can resolve in the fork's
 * placement metadata table. The managed component must register its real
 * geometry, or a tall image simply overdraws the rows below it.
 *
 * The control is the legacy `Image` in the SAME module graph: both must crop to
 * the same source rectangle, and neither may crop when the whole image fits.
 */
function croppingCase(kind: 'legacy' | 'native', viewportRows: number): string | null {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const terminal = new RecordingTerminal()
  terminal.columns = 60
  terminal.rows = viewportRows
  const core = new KittyGraphicsCore()
  const image = kind === 'native'
    ? new NativeKittyImage(core, { pngBase64: PNG, widthPx: 100, heightPx: 500 }, {
      maxWidthCells: 20,
      maxHeightCells: 10,
      fallback: '[image]',
    })
    : new LegacyImage(PNG, 'image/png', { fallbackColor: (text: string) => text }, {
      maxWidthCells: 20,
      maxHeightCells: 10,
    }, { widthPx: 100, heightPx: 500 })
  class Rows implements Component {
    render(width: number): string[] {
      const lines = ['l0', 'l1', 'l2', 'l3']
      lines.push(...image.render(width))
      return lines
    }
    invalidate(): void {
      image.invalidate()
    }
  }
  const screen = new TuiAltScreen(new KittyTerminalFacade(terminal, core), undefined, undefined, { mouse: false })
  screen.addChild(new Rows())
  screen.start()
  screen.renderNow()
  const wire = terminal.text
  const match = /,y=(\d+),h=(\d+),r=(\d+)/.exec(wire)
  screen.stop()
  return match === null ? null : `y=${match[1]},h=${match[2]},r=${match[3]}`
}

/**
 * The scroll-into-middle path: the anchor row is ABOVE the viewport and the
 * image extends into it, so the layout engine must restore the REMAINING part
 * with a source rectangle (`y`/`h`/`r`) instead of dropping the image. This is
 * the second half of the crop contract the fork metadata registration serves.
 */
function scrollCroppingCase(kind: 'legacy' | 'native', scrollTop: number): { top: number; crop: string | null } {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const terminal = new RecordingTerminal()
  terminal.columns = 60
  terminal.rows = 10
  const core = new KittyGraphicsCore()
  const image = kind === 'native'
    ? new NativeKittyImage(core, { pngBase64: PNG, widthPx: 100, heightPx: 500 }, {
      maxWidthCells: 20,
      maxHeightCells: 10,
      fallback: '[image]',
    })
    : new LegacyImage(PNG, 'image/png', { fallbackColor: (text: string) => text }, {
      maxWidthCells: 20,
      maxHeightCells: 10,
    }, { widthPx: 100, heightPx: 500 })
  const content = new LegacyContainer()
  for (let index = 0; index < 3; index++) content.addChild(new LegacyText(`l${index}`, 0, 0))
  content.addChild(image)
  for (let index = 0; index < 20; index++) content.addChild(new LegacyText(`t${index}`, 0, 0))
  const scroll = new LegacyScrollView(content, { primary: true, follow: 'none' })
  const screen = new TuiAltScreen(new KittyTerminalFacade(terminal, core), undefined, undefined, { mouse: false })
  screen.setLayoutRoot(scroll)
  screen.start()
  screen.renderNow()
  scroll.scrollTo(scrollTop)
  image.invalidate()
  content.invalidate()
  terminal.writes.length = 0
  screen.renderNow()
  const match = /,y=(\d+),h=(\d+),r=(\d+)/.exec(terminal.text)
  const top = scroll.scrollTop
  screen.stop()
  return { top, crop: match === null ? null : `y=${match[1]},h=${match[2]},r=${match[3]}` }
}

test('scrolling into a managed image restores the same remaining part as the legacy image', () => {
  for (const offset of [2, 4, 6]) {
    const legacy = scrollCroppingCase('legacy', offset)
    const native = scrollCroppingCase('native', offset)
    assert.equal(legacy.top, offset, `legacy scroll position ${offset}`)
    assert.equal(native.top, legacy.top, `native scroll position matches at ${offset}`)
    assert.ok(legacy.crop !== null, `the control restores a cropped source rectangle at ${offset}`)
    assert.equal(native.crop, legacy.crop, `the managed placement restores the same rectangle at ${offset}`)
  }
  // The restored rectangle really tracks the scroll position.
  const first = scrollCroppingCase('native', 2).crop
  const later = scrollCroppingCase('native', 6).crop
  assert.notEqual(first, later, 'a deeper scroll yields a different source rectangle')
})

/**
 * Bottom clipping: the image anchor is INSIDE the viewport but the image is
 * taller than the remaining rows, so the layout engine must clip its bottom.
 */
test('a managed placement is cropped exactly like the legacy image at the viewport edge', () => {
  assert.equal(croppingCase('legacy', 8), 'y=100,h=400,r=8', 'the control crops')
  assert.equal(croppingCase('native', 8), 'y=100,h=400,r=8', 'the managed placement crops to the same rectangle')
  assert.equal(croppingCase('legacy', 12), null, 'the control never crops when the whole image fits')
  assert.equal(croppingCase('native', 12), null, 'and neither does the managed placement')
})


/**
 * Registering placement metadata makes the alternate screen's
 * `prepareKittyScreen()` recognise a managed `a=p` row. It must NOT become a
 * second upload authority: the Core still owns transmission and retirement,
 * and a redraw must never re-transmit a resident image.
 */
test('metadata registration does not hand upload authority to the alt screen', () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const terminal = new RecordingTerminal()
  const core = new KittyGraphicsCore()
  const facade = new KittyTerminalFacade(terminal, core)
  const image = new NativeKittyImage(core, { pngBase64: PNG, widthPx: 100, heightPx: 500 }, {
    maxWidthCells: 20,
    maxHeightCells: 10,
    fallback: '[image]',
  })
  let extra = 0
  class Rows implements Component {
    render(width: number): string[] {
      const lines = ['head', ...image.render(width)]
      for (let index = 0; index < extra; index++) lines.push(`extra ${index}`)
      return lines
    }
    invalidate(): void {
      image.invalidate()
    }
  }
  const screen = new TuiAltScreen(facade, undefined, undefined, { mouse: false })
  screen.addChild(new Rows())
  screen.start()
  screen.renderNow()
  const imageId = image.imageId!

  // An ordinary text change repaints; the managed payload is already resident.
  terminal.writes.length = 0
  extra = 1
  screen.invalidate()
  screen.renderNow()
  const wire = terminal.text
  assert.equal(apcs(wire).filter((entry) => entry.a === 't').length, 0, 'no re-transmission from the alt screen')
  assert.ok(!wire.includes('a=d,d=I'), 'and no data free')
  assert.ok(core.owns(imageId), 'the Core still owns the image')

  // Only the Core decides its lifetime. A PAINTED occurrence is terminal-
  // retained (Owner ruling): its retire keeps the pixels and frees only the
  // Core's own payload, so no hard delete appears here.
  terminal.writes.length = 0
  image.dispose()
  facade.write('frame')
  assert.ok(!terminal.text.includes(`a=d,d=I,i=${imageId}`), 'the alt screen never frees a painted image')
  assert.equal(core.owns(imageId), false, 'the occurrence left the active ledger')
  assert.equal(core.residentPayloadBytes, 0, 'its payload copy is released')
  screen.stop()
})


/**
 * X066 (Owner-approved fork hardening): a failing cleanup write in the alternate
 * screen's own `beforeTerminalStop()` must not strand the terminal. The screen
 * hooks and the physical release still run, the alternate screen still exits,
 * the ORIGINAL cleanup error still propagates, and the Core never treats the
 * failed delete as a success.
 */
function failingStop(kind: 'alt' | 'main', preserveScreen: boolean) {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const terminal = new RecordingTerminal()
  const stopped: string[] = []
  const originalStop = terminal.stop.bind(terminal)
  terminal.stop = () => {
    stopped.push('terminal.stop')
    originalStop()
  }
  const originalShow = terminal.showCursor.bind(terminal)
  terminal.showCursor = () => {
    stopped.push('showCursor')
    originalShow()
  }
  const core = new KittyGraphicsCore()
  const facade = new KittyTerminalFacade(terminal, core)
  const image = new NativeKittyImage(core, { pngBase64: PNG, widthPx: 64, heightPx: 64 }, {
    maxWidthCells: 20,
    maxHeightCells: 6,
    fallback: '[image]',
  })
  class Rows implements Component {
    render(width: number): string[] {
      return ['head', ...image.render(width), 'tail']
    }
    invalidate(): void {
      image.invalidate()
    }
  }
  const screen = kind === 'alt'
    ? new TuiAltScreen(facade, undefined, undefined, { mouse: false })
    : new TuiMainScreen(facade)
  screen.addChild(new Rows())
  screen.start()
  screen.renderNow()
  const imageId = image.imageId!
  terminal.writes.length = 0
  // The alternate screen's own global cleanup is the first write of its stop.
  terminal.failWhen = (data) => data.includes('a=d')
  let failure: unknown
  try {
    screen.stop({ preserveScreen })
  } catch (error) {
    failure = error
  }
  return {
    failure: failure instanceof Error ? failure.message : null,
    stopped,
    altExit: terminal.text.includes('\x1b[?1049l'),
    owned: core.owns(imageId),
  }
}

test('a failing cleanup write still restores the terminal and keeps the error (alt)', () => {
  for (const preserveScreen of [false, true]) {
    const result = failingStop('alt', preserveScreen)
    assert.equal(result.failure, 'terminal write failed', `preserveScreen=${preserveScreen}: the original error propagates`)
    assert.ok(result.stopped.includes('showCursor'), 'the cursor was restored')
    assert.ok(result.stopped.includes('terminal.stop'), 'the physical terminal was released')
    assert.ok(result.altExit, 'the alternate screen was exited')
    assert.equal(result.owned, true, 'the Core did not treat the failed delete as a success')
  }
})

test('a normal main-screen stop is unaffected by the teardown hardening', () => {
  const result = failingStop('main', false)
  assert.equal(result.failure, null, 'a main stop does not write a kitty global delete')
  assert.ok(result.stopped.includes('showCursor'))
  assert.ok(result.stopped.includes('terminal.stop'))
  assert.equal(result.owned, true)
})
