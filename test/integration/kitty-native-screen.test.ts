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
  setCapabilities,
  type Component,
  type Terminal,
  type TerminalProgressState,
} from '@xmoon76/pi-tui'
import { ImageThumbnail } from '../../src/tui/components/media/image-thumbnail.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { KittyGraphicsCore } from '../../src/tui/graphics/kitty-core.ts'
import { parseKittyApc } from '../../src/tui/graphics/kitty-native.ts'
import { KittyTerminalFacade } from '../../src/tui/graphics/kitty-terminal.ts'
import { NativeKittyImage } from '../../src/tui/graphics/native-image.ts'
import type { NativeKittyGraphics } from '../../src/tui/graphics/native-image.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

class RecordingTerminal implements Terminal {
  readonly writes: string[] = []
  columns = 100
  rows = 40
  kittyProtocolActive = false

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

test('main screen: stop retires only never-painted uploads and preserves painted scrollback', () => {
  const { terminal, core, facade } = setup()
  const root = new Root(core)
  const screen = new TuiMainScreen(facade)
  screen.addChild(root)
  screen.start()
  screen.renderNow()
  const paintedId = root.imageA.imageId!
  const unplaced = core.register({ pngBase64: PNG, widthPx: 8, heightPx: 8 })!
  facade.write(core.transmissionFor(unplaced.imageId, 'main'))

  terminal.writes.length = 0
  screen.stop()
  const text = terminal.text
  assert.ok(text.includes(`a=d,d=I,i=${unplaced.imageId}`), 'the invisible upload is freed')
  assert.ok(!text.includes(`a=d,d=I,i=${paintedId}`), 'the painted scrollback image is preserved')
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
  const graphics: NativeKittyGraphics = {
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
