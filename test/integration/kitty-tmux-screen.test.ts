/**
 * Image-7B-A — the tmux virtual backend behind the REAL fork screens.
 *
 * These cases mount the actual `TuiMainScreen` / `TuiAltScreen` writer with the
 * production factory, a real `KittyGraphicsCore` and a real
 * `KittyTerminalFacade`. The tmux server boundary is a scripted executable on
 * PATH (raw stdout only), so the decision under test is still produced from the
 * real subprocess output. The only E3 fact these cases cannot provide is a real
 * outer GUI/passthrough; that is the separate real-terminal qualification.
 * @module @xmoon76/dsh-pi-tui/integration/kitty-tmux-screen.test
 */

import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import {
  Container as LegacyContainer,
  ScrollView as LegacyScrollView,
  Text as LegacyText,
  TuiAltScreen,
  TuiMainScreen,
  setCapabilities,
  setCellDimensions,
  type Component,
  type Terminal,
  type TerminalProgressState,
} from '@xmoon76/pi-tui'
import { KittyGraphicsCore } from '../../src/tui/graphics/kitty-core.ts'
import { parseKittyApc, type KittyApc } from '../../src/tui/graphics/kitty-native.ts'
import { KittyTerminalFacade, TmuxGraphicsRevokedError } from '../../src/tui/graphics/kitty-terminal.ts'
import { createTmuxKittyGraphics, TmuxKittyImage } from '../../src/tui/graphics/tmux-image.ts'
import type { KittyGraphics, NativeKittyImageOptions } from '../../src/tui/graphics/native-image.ts'
import { TmuxKittyAdmission, probeTmuxKittyIdentity } from '../../src/tui/graphics/tmux-admission.ts'
import {
  KITTY_VIRTUAL_PLACEHOLDER,
  encodeKittyPlaceholderGrid,
  encodeKittyVirtualPlacement,
} from '../../src/tui/graphics/tmux-virtual.ts'
import { createFakeTmuxCli, type FakeTmuxCli } from '../support/fake-tmux-cli.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const DCS_INTRODUCER = '\x1bPtmux;'
const P = KITTY_VIRTUAL_PLACEHOLDER

class RecordingTerminal implements Terminal {
  readonly writes: string[] = []
  columns = 100
  rows = 40
  kittyProtocolActive = true
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

interface OuterScan {
  /** The stream with every DCS-wrapped command removed (text/control only). */
  readonly text: string
  /** Every managed command that was really wrapped in a tmux DCS. */
  readonly commands: KittyApc[]
}

/**
 * Decode the outer stream the way tmux would: a DCS whose payload ESC bytes are
 * doubled is one passthrough unit. Any `ESC_G` left in `text` is therefore an
 * unwrapped Kitty command that escaped the gate.
 */
function scanOuter(stream: string): OuterScan {
  let text = ''
  const commands: KittyApc[] = []
  let index = 0
  while (index < stream.length) {
    const start = stream.indexOf(DCS_INTRODUCER, index)
    if (start === -1) {
      text += stream.slice(index)
      break
    }
    text += stream.slice(index, start)
    let cursor = start + DCS_INTRODUCER.length
    let inner = ''
    for (;;) {
      assert.ok(cursor < stream.length, 'every DCS is terminated')
      const char = stream[cursor]!
      if (char === '\x1b') {
        const next = stream[cursor + 1]
        if (next === '\x1b') {
          inner += '\x1b'
          cursor += 2
          continue
        }
        assert.equal(next, '\\', 'a DCS payload may only contain doubled ESC bytes')
        cursor += 2
        break
      }
      inner += char
      cursor += 1
    }
    const command = parseKittyApc(inner)
    assert.ok(command, `each DCS wraps exactly one well-formed Kitty APC: ${JSON.stringify(inner.slice(0, 40))}`)
    commands.push(command)
    index = cursor
  }
  return { text, commands }
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

function assertNoUnwrappedGraphics(scan: OuterScan): void {
  assert.equal(scan.text.includes('\x1b_G'), false, 'no managed Kitty APC may escape its DCS')
}

function source(payload = PNG, widthPx = 64, heightPx = 64) {
  return { pngBase64: payload, widthPx, heightPx }
}

interface Harness {
  readonly cli: FakeTmuxCli
  readonly terminal: RecordingTerminal
  readonly graphics: KittyGraphics
  dispose(): void
}

function harness(t: TestContext): Harness {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const cli = createFakeTmuxCli(t)
  const terminal = new RecordingTerminal()
  const graphics = createTmuxKittyGraphics(terminal, {}, cli.env)
  assert.ok(graphics, 'the default scripted server is the admitted topology')
  return {
    cli,
    terminal,
    graphics,
    dispose() {
      graphics.dispose()
      cli.dispose()
    },
  }
}

function imageOf(graphics: KittyGraphics, payload: ReturnType<typeof source>, options: NativeKittyImageOptions): TmuxKittyImage {
  return graphics.image(payload, options) as TmuxKittyImage
}

function fallbackOptions(): NativeKittyImageOptions {
  return { maxWidthCells: 30, maxHeightCells: 10, fallback: '[fallback]' }
}

test('the factory refuses to create a handle unless the live server admits it', (t) => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const cases: ReadonlyArray<{ name: string; mutate: (cli: FakeTmuxCli) => void }> = [
    { name: 'opt-in absent', mutate: (cli) => { delete cli.env.PI_TUI_TMUX_KITTY_IMAGES } },
    { name: 'passthrough on', mutate: (cli) => cli.setReply('show-options', { text: 'on\n' }) },
    { name: 'no client', mutate: (cli) => cli.setReply('list-clients', { text: '' }) },
    { name: 'non-Kitty client', mutate: (cli) => cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\ttmux-256color\t\n' }) },
  ]
  for (const entry of cases) {
    const cli = createFakeTmuxCli(t)
    const terminal = new RecordingTerminal()
    try {
      entry.mutate(cli)
      assert.equal(createTmuxKittyGraphics(terminal, {}, cli.env), undefined, entry.name)
      assert.equal(terminal.text, '', `${entry.name}: no bytes and no image work before admission`)
    } finally {
      cli.dispose()
    }
  }
})

test('main screen first paint: one wrapped upload, then the placement and real grid cells', (t) => {
  const h = harness(t)
  try {
    const image = imageOf(h.graphics, source(), fallbackOptions())
    class Root implements Component {
      render(width: number): string[] {
        return ['title', ...image.render(width), 'END']
      }
      invalidate(): void {
        image.invalidate()
      }
    }
    const screen = new TuiMainScreen(h.graphics.terminal)
    screen.addChild(new Root())
    screen.start()
    h.terminal.writes.length = 0
    screen.renderNow()

    const scan = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(scan)
    const transmissions = scan.commands.filter((command) => command.controls.a === 't')
    const placements = scan.commands.filter((command) => command.controls.a === 'p')
    assert.equal(transmissions.length, 1, 'the payload is uploaded exactly once')
    assert.equal(placements.length, 1, 'one virtual placement anchor')
    assert.equal(transmissions[0]!.controls.i, placements[0]!.controls.i)
    assert.equal(transmissions[0]!.controls.q, '2')
    assert.equal(placements[0]!.controls.U, '1', 'the placement is the virtual prototype')
    assert.equal(placements[0]!.controls.q, '2')
    const body = image.paintedBodyAt(100)
    assert.ok(body !== undefined)
    assert.equal(Number(placements[0]!.controls.c), body.columns)
    assert.equal(Number(placements[0]!.controls.r), body.rows)
    assert.equal(count(scan.text, P), body.columns * body.rows, 'every painted cell is real placeholder text')
    const grid = encodeKittyPlaceholderGrid(Number(placements[0]!.controls.i), Number(placements[0]!.controls.p), body.columns, body.rows)
    for (const row of grid) assert.ok(scan.text.includes(row), 'each grid row reached the text stream')
    assert.equal(h.terminal.text.includes('pi:tmux-image'), false, 'the private provenance marker never reaches the terminal')
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('a payload above the APC chunk ceiling uploads as separate wrapped chunks', (t) => {
  const h = harness(t)
  try {
    const payload = 'A'.repeat(4096 * 2 + 128)
    const image = imageOf(h.graphics, { pngBase64: payload, widthPx: 64, heightPx: 64 }, fallbackOptions())
    h.graphics.terminal.write(image.render(80).join('\r\n'))
    const scan = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(scan)
    const transmissions = scan.commands.filter((command) => command.controls.a === 't' || command.controls.m !== undefined)
    assert.equal(transmissions.length, 3, 'one DCS per transmission chunk')
    assert.deepEqual(transmissions.map((command) => command.controls.m), ['1', '1', '0'])
    for (const [index, command] of transmissions.entries()) {
      assert.equal(command.controls.q, '2', `chunk ${index} is quiet`)
      assert.ok(command.payload.length <= 4096, `chunk ${index} stays within the ceiling`)
      assert.equal(command.payload.length % 4, 0)
    }
    assert.equal(scan.commands.findIndex((command) => command.controls.a === 'p'), 3,
      'the placement follows every chunk')
  } finally {
    h.dispose()
  }
})

test('main screen steady frame: a text change never re-uploads or re-places the image', (t) => {
  const h = harness(t)
  try {
    const image = imageOf(h.graphics, source(), fallbackOptions())
    let status = 0
    class Root implements Component {
      render(width: number): string[] {
        return ['title', ...image.render(width), `status ${status}`]
      }
      invalidate(): void {
        image.invalidate()
      }
    }
    const screen = new TuiMainScreen(h.graphics.terminal)
    screen.addChild(new Root())
    screen.start()
    screen.renderNow()
    h.terminal.writes.length = 0
    status = 1
    screen.renderNow()
    const scan = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(scan)
    assert.equal(scan.commands.filter((command) => command.controls.a === 't').length, 0, 'no re-upload')
    assert.equal(count(scan.text, P), 0, 'the unchanged image lines are not re-painted')
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('main screen hide/show is text-cell visibility, never a Kitty delete', (t) => {
  const h = harness(t)
  try {
    const image = imageOf(h.graphics, source(), fallbackOptions())
    let show = true
    class Root implements Component {
      render(width: number): string[] {
        return ['head', ...(show ? image.render(width) : []), 'tail']
      }
      invalidate(): void {
        image.invalidate()
      }
    }
    const screen = new TuiMainScreen(h.graphics.terminal)
    screen.addChild(new Root())
    screen.start()
    screen.renderNow()

    h.terminal.writes.length = 0
    show = false
    screen.renderNow()
    const hidden = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(hidden)
    assert.equal(hidden.commands.length, 0, 'the writer delete translated to no bytes')
    assert.equal(count(hidden.text, P), 0, 'the placeholder cells were erased')

    h.terminal.writes.length = 0
    show = true
    screen.renderNow()
    const shown = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(shown)
    assert.equal(shown.commands.filter((command) => command.controls.a === 't').length, 0,
      'the resident data is reused on re-show')
    assert.equal(shown.commands.filter((command) => command.controls.a === 'p').length, 1)
    assert.ok(count(shown.text, P) > 0)
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('main screen clear: the next placement re-uploads after the clear and before the grid', (t) => {
  const h = harness(t)
  try {
    const image = imageOf(h.graphics, source(), fallbackOptions())
    class Root implements Component {
      render(width: number): string[] {
        return ['title', ...image.render(width)]
      }
      invalidate(): void {
        image.invalidate()
      }
    }
    const screen = new TuiMainScreen(h.graphics.terminal)
    screen.addChild(new Root())
    screen.start()
    screen.renderNow()

    h.terminal.writes.length = 0
    h.terminal.columns = 70
    screen.renderNow()
    const scan = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(scan)
    const clear2 = h.terminal.text.indexOf('\x1b[2J')
    const clear3 = h.terminal.text.indexOf('\x1b[3J')
    const firstDcs = h.terminal.text.indexOf(DCS_INTRODUCER)
    const transmissions = scan.commands.filter((command) => command.controls.a === 't')
    const placements = scan.commands.filter((command) => command.controls.a === 'p')
    assert.ok(clear2 !== -1 && clear3 !== -1)
    assert.equal(transmissions.length, 1, 'the cleared payload is uploaded again')
    assert.equal(placements.length, 1)
    assert.ok(clear2 < clear3 && firstDcs > clear3, 'the wrapped upload happens after the invalidating clears')
    assert.equal(count(scan.text, P), Number(placements[0]!.controls.c) * Number(placements[0]!.controls.r))
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('main screen scrollback: a retired painted image is never hard-deleted, and ids are not reused', (t) => {
  const h = harness(t)
  try {
    let current = imageOf(h.graphics, source(), fallbackOptions())
    class Root implements Component {
      render(width: number): string[] {
        return ['head', ...current.render(width), 'tail']
      }
      invalidate(): void {
        current.invalidate()
      }
    }
    const screen = new TuiMainScreen(h.graphics.terminal)
    screen.addChild(new Root())
    screen.start()
    screen.renderNow()
    const firstId = current.imageId!
    screen.renderNow()
    const seen = new Set<number>([firstId])

    current.dispose()
    for (let index = 0; index < 30; index++) {
      current = imageOf(h.graphics, source(PNG, 8, 8), fallbackOptions())
      screen.invalidate()
      h.terminal.writes.length = 0
      screen.renderNow()
      const id = current.imageId!
      assert.equal(seen.has(id), false, `occurrence ${index} got a fresh id`)
      seen.add(id)
      const scan = scanOuter(h.terminal.text)
      assertNoUnwrappedGraphics(scan)
      assert.equal(scan.commands.some((command) => command.controls.a === 'd'), false,
        'the Core never frees a painted scrollback image')
      assert.equal(h.terminal.text.includes('a=d'), false, 'and no delete reaches the outer terminal')
      current.dispose()
    }
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('alt screen: the upload happens after ?1049h and a non-preserving stop replays the image without deletes', (t) => {
  const h = harness(t)
  try {
    const image = imageOf(h.graphics, source(), fallbackOptions())
    class Root implements Component {
      render(width: number): string[] {
        return ['head', ...image.render(width), 'tail']
      }
      invalidate(): void {
        image.invalidate()
      }
    }
    const screen = new TuiAltScreen(h.graphics.terminal, undefined, undefined, { mouse: false })
    screen.addChild(new Root())
    screen.start()
    screen.renderNow()
    const painted = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(painted)
    assert.ok(h.terminal.text.indexOf('\x1b[?1049h') >= 0)
    assert.ok(h.terminal.text.indexOf(DCS_INTRODUCER) > h.terminal.text.indexOf('\x1b[?1049h'),
      'the upload happens inside the alternate screen')
    assert.equal(painted.commands.filter((command) => command.controls.a === 't').length, 1)
    assert.equal(painted.commands.filter((command) => command.controls.a === 'p').length, 1)

    h.terminal.writes.length = 0
    screen.stop({ preserveScreen: false })
    const replay = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(replay)
    assert.equal(h.terminal.text.includes('pi:tmux-image'), false, 'the Alt replay path strips the marker too')
    const exitAt = h.terminal.text.lastIndexOf('\x1b[?1049l')
    assert.ok(exitAt !== -1)
    assert.ok(h.terminal.text.lastIndexOf(DCS_INTRODUCER) > exitAt, 'the replayed placement follows ?1049l')
    assert.equal(replay.commands.filter((command) => command.controls.a === 'd').length, 0,
      'the replay never frees the image it still refers to')
    assert.equal(replay.commands.filter((command) => command.controls.a === 't').length, 0,
      'the data is still resident after leaving the alternate screen')
    assert.ok(count(h.terminal.text.slice(exitAt), P) > 0, 'the grid really lands on the main screen')
  } finally {
    h.dispose()
  }
})

test('alt screen: preserveScreen leaves no ghost image behind', (t) => {
  const h = harness(t)
  try {
    const image = imageOf(h.graphics, source(), fallbackOptions())
    class Root implements Component {
      render(width: number): string[] {
        return ['head', ...image.render(width)]
      }
      invalidate(): void {
        image.invalidate()
      }
    }
    const screen = new TuiAltScreen(h.graphics.terminal, undefined, undefined, { mouse: false })
    screen.addChild(new Root())
    screen.start()
    screen.renderNow()
    h.terminal.writes.length = 0
    screen.stop({ preserveScreen: true })
    const scan = scanOuter(h.terminal.text)
    const exitAt = h.terminal.text.lastIndexOf('\x1b[?1049l')
    assert.ok(exitAt !== -1)
    const after = h.terminal.text.slice(exitAt)
    assert.equal(count(after, P), 0, 'nothing is replayed onto the main screen')
    assert.equal(after.includes(DCS_INTRODUCER), false, 'and no placement is re-emitted')
    assert.equal(scan.text.includes('\x1b_G'), false)
  } finally {
    h.dispose()
  }
})

test('alt screen: a fresh session re-uploads after its own clear and re-places', (t) => {
  const h = harness(t)
  try {
    const image = imageOf(h.graphics, source(), fallbackOptions())
    class Root implements Component {
      render(width: number): string[] {
        return ['head', ...image.render(width)]
      }
      invalidate(): void {
        image.invalidate()
      }
    }
    const screen = new TuiAltScreen(h.graphics.terminal, undefined, undefined, { mouse: false })
    screen.addChild(new Root())
    screen.start()
    screen.renderNow()
    screen.stop({ preserveScreen: true })
    h.terminal.writes.length = 0
    screen.start()
    screen.renderNow()
    const scan = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(scan)
    assert.ok(h.terminal.text.indexOf('\x1b[?1049h') < h.terminal.text.indexOf(DCS_INTRODUCER))
    assert.equal(scan.commands.filter((command) => command.controls.a === 't').length, 1,
      'the new alternate session starts from an empty image store')
    assert.equal(scan.commands.filter((command) => command.controls.a === 'p').length, 1)
    assert.equal(scan.commands.some((command) => command.controls.a === 'd'), false)
    screen.stop()
  } finally {
    h.dispose()
  }
})

/**
 * A scripted facade over the real Core for the permission cases: the factory's
 * own admission is exercised separately, and this fixture needs direct control
 * of core ids to pick a guaranteed-foreign id.
 */
function directFacade(t: TestContext): {
  terminal: RecordingTerminal
  core: KittyGraphicsCore
  facade: KittyTerminalFacade
  admission: TmuxKittyAdmission
  dispose(): void
} {
  const cli = createFakeTmuxCli(t)
  const identity = probeTmuxKittyIdentity(cli.env)
  assert.ok(identity)
  const admission = new TmuxKittyAdmission(identity, cli.env)
  const terminal = new RecordingTerminal()
  const core = new KittyGraphicsCore({ placementMode: 'tmux-virtual' })
  const facade = new KittyTerminalFacade(terminal, core, { placementMode: 'tmux-virtual', admission })
  return {
    terminal,
    core,
    facade,
    admission,
    dispose() {
      facade.dispose()
      core.dispose()
      cli.dispose()
    },
  }
}

test('tmux virtual: foreign per-id commands stay byte-for-byte while own/global deletes emit nothing', (t) => {
  const { terminal, core, facade, dispose } = directFacade(t)
  try {
  let foreign = 1
  while (core.ownsIdSpace(foreign)) foreign += 1
  const foreignTransmit = `\x1b_Ga=T,f=100,q=2,i=${foreign},p=7,c=6,r=3,C=1;AAAA\x1b\\`
  facade.write(foreignTransmit)
  assert.equal(terminal.text, foreignTransmit, 'a foreign transmission is never wrapped or hijacked')

  const foreignDelete = `\x1b_Ga=d,d=I,i=${foreign},q=2\x1b\\`
  terminal.writes.length = 0
  facade.write(foreignDelete)
  assert.equal(terminal.text, foreignDelete, 'a foreign per-id delete is untouched')

  const own = core.register(source())!
  terminal.writes.length = 0
  facade.write(`\x1b_Ga=d,d=I,i=${own.imageId},q=2\x1b\\`)
  assert.equal(terminal.text, '', 'the writer delete of an own id is layout intent only')
  facade.write('\x1b_Ga=d,d=A,q=2\x1b\\')
  facade.write('\x1b_Ga=d,d=a,q=2\x1b\\')
  facade.write('\x1b_Ga=d\x1b\\')
  assert.equal(terminal.text, '', 'no global delete form may reach the outer terminal')
  assert.equal(core.owns(own.imageId), true, 'a writer delete never frees Core ownership')
  } finally {
    dispose()
  }
})

test('tmux virtual: an unpainted occurrence retires with a wrapped own-ID delete', (t) => {
  const { terminal, core, facade, admission, dispose } = directFacade(t)
  try {
    const component = new TmuxKittyImage(core, source(), fallbackOptions(), admission)
    component.render(80)
    const imageId = component.imageId!
    component.dispose()
    terminal.writes.length = 0
    facade.write('after')
    const scan = scanOuter(terminal.text)
    assertNoUnwrappedGraphics(scan)
    assert.deepEqual(scan.commands.map((command) => ({ a: command.controls.a, d: command.controls.d, i: command.controls.i })), [
      { a: 'd', d: 'I', i: String(imageId) },
    ])
    assert.ok(scan.text.endsWith('after'))
  } finally {
    dispose()
  }
})

test('tmux virtual: a failed frame clears residency and the next placement re-uploads', (t) => {
  const h = harness(t)
  try {
    const image = imageOf(h.graphics, source(), fallbackOptions())
    class Root implements Component {
      render(width: number): string[] {
        return ['head', ...image.render(width)]
      }
      invalidate(): void {
        image.invalidate()
      }
    }
    const screen = new TuiMainScreen(h.graphics.terminal)
    screen.addChild(new Root())
    screen.start()
    screen.renderNow()

    h.terminal.writes.length = 0
    h.terminal.columns = 90
    h.terminal.failWhen = (data) => data.includes(DCS_INTRODUCER)
    assert.throws(() => screen.renderNow(), /terminal write failed/)

    h.terminal.writes.length = 0
    screen.renderNow()
    const scan = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(scan)
    assert.equal(scan.commands.filter((command) => command.controls.a === 't').length, 1,
      'the payload is sent again after the ambiguous failure')
    assert.ok(h.terminal.text.indexOf(DCS_INTRODUCER) < h.terminal.text.indexOf(P))
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('tmux virtual: a revoked client permanently refuses managed batches and paints text fallback', (t) => {
  const h = harness(t)
  try {
    const image = imageOf(h.graphics, source(), fallbackOptions())
    const anchor = image.render(100)[0]!
    h.graphics.terminal.write(anchor)
    assert.equal(h.graphics.canPaint(), true)

    h.cli.setReply('show-options', { text: 'on\n' })
    h.terminal.writes.length = 0
    assert.throws(() => h.graphics.terminal.write(anchor), TmuxGraphicsRevokedError)
    assert.equal(h.terminal.text, '', 'the whole managed batch is refused, including its grid')

    h.cli.setReply('show-options', { text: 'all\n' })
    assert.throws(() => h.graphics.terminal.write(anchor), TmuxGraphicsRevokedError)
    assert.equal(h.graphics.canPaint(), false)

    const fallback = image.render(100)
    assert.deepEqual(fallback, ['[fallback]'])
    assert.equal(image.paintedBodyAt(100), undefined)
    h.terminal.writes.length = 0
    h.graphics.terminal.write(fallback.join('\r\n'))
    const scan = scanOuter(h.terminal.text)
    assert.equal(scan.commands.length, 0)
    assert.equal(count(scan.text, P), 0, 'no placeholder cell may follow a revoked admission')
  } finally {
    h.dispose()
  }
})

test('tmux virtual: a revoked handle drops a queued unpainted retirement and writes text', (t) => {
  const h = harness(t)
  try {
    const pending = imageOf(h.graphics, source(), fallbackOptions())
    pending.render(100) // registered, never offered to the screen/terminal
    pending.dispose() // queued hard retirement
    h.cli.setReply('show-options', { text: 'off\n' })
    h.terminal.writes.length = 0
    h.graphics.terminal.write('fallback text')
    assert.equal(h.terminal.text, 'fallback text', 'the text frame is still writable after revocation')
    assert.equal(h.terminal.text.includes('\x1b_G'), false, 'the old retirement never reaches the pane')
    assert.equal(count(h.terminal.text, P), 0)
  } finally {
    h.dispose()
  }
})

test('tmux virtual: a real screen writes its fallback after a revoked queued retirement', (t) => {
  const h = harness(t)
  try {
    const pending = imageOf(h.graphics, source(), fallbackOptions())
    pending.render(100)
    pending.dispose()
    h.cli.setReply('show-options', { text: 'off\n' })
    class Plain implements Component {
      render(): string[] {
        return ['plain fallback']
      }
      invalidate(): void {}
    }
    const screen = new TuiMainScreen(h.graphics.terminal)
    screen.addChild(new Plain())
    h.terminal.writes.length = 0
    screen.start()
    screen.renderNow()
    const scan = scanOuter(h.terminal.text)
    assert.equal(scan.commands.length, 0, 'no managed command')
    assert.equal(count(scan.text, P), 0, 'no placeholder cell')
    assert.ok(scan.text.includes('plain fallback'), 'the real screen painted the text fallback')
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('tmux virtual: a revoked screen repaints its fallback without escaping one grid cell', (t) => {
  const h = harness(t)
  try {
    const image = imageOf(h.graphics, source(), fallbackOptions())
    let status = 0
    class Root implements Component {
      render(width: number): string[] {
        return ['head', ...image.render(width), `status ${status}`]
      }
      invalidate(): void {
        image.invalidate()
      }
    }
    const screen = new TuiMainScreen(h.graphics.terminal)
    screen.addChild(new Root())
    screen.start()
    screen.renderNow()
    const anchor = image.render(100)[0]!

    h.cli.setReply('show-options', { text: 'off\n' })
    assert.throws(() => h.graphics.terminal.write(anchor), TmuxGraphicsRevokedError)

    status = 1
    h.terminal.writes.length = 0
    screen.renderNow()
    const scan = scanOuter(h.terminal.text)
    assert.equal(scan.commands.length, 0, 'the fallback frame carries no managed command')
    assert.equal(count(scan.text, P), 0, 'and no placeholder cell escapes the revoked handle')
    assert.ok(scan.text.includes('[fallback]'), 'the real screen paints the text fallback')
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('tmux virtual: the budget falls back to text, and 100 painted images keep their ids and pixels', (t) => {
  const { terminal, core, facade, admission, dispose } = directFacade(t)
  try {
  const side = Math.floor(Math.sqrt((256 * 1024 * 1024) / 4)) + 1
  const oversized = core.register(source(PNG, side, side))
  assert.equal(oversized, undefined, 'the frozen decoded budget is unchanged')
  const refused = new TmuxKittyImage(
    core,
    source(PNG, side, side),
    fallbackOptions(),
    admission,
  )
  assert.deepEqual(refused.render(80), ['[fallback]'])
  assert.equal(refused.paintedBodyAt(80), undefined)

  const seen = new Set<number>()
  for (let index = 0; index < 100; index++) {
    const component = new TmuxKittyImage(
      core,
      source(PNG, 4, 4),
      fallbackOptions(),
      admission,
    )
    terminal.writes.length = 0
    facade.write(component.render(80).join('\r\n'))
    const scan = scanOuter(terminal.text)
    assertNoUnwrappedGraphics(scan)
    assert.equal(scan.commands.filter((command) => command.controls.a === 'p').length, 1,
      `occurrence ${index} painted`)
    const imageId = component.imageId!
    assert.equal(seen.has(imageId), false, `occurrence ${index} got a fresh id`)
    seen.add(imageId)
    component.dispose()
    assert.equal(core.residentImageCount, 0, 'the painted occurrence leaves the active set')
    assert.equal(core.residentPayloadBytes, 0)
  }
  assert.ok(core.register(source(PNG, 4, 4)), 'a new occurrence still admits after 100 images')
  for (const id of seen) assert.equal(core.ownsIdSpace(id), true)
  } finally {
    dispose()
  }
})

test('tmux virtual: the component bounds the grid before the encoder, and a narrow width narrows the image', (t) => {
  const { core, admission, dispose } = directFacade(t)
  try {
  const image = new TmuxKittyImage(core, source(PNG, 4000, 2000), { maxWidthCells: 700, fallback: '[fallback]' }, admission)
  const wide = image.render(600)
  const wideBody = image.paintedBodyAt(600)!
  assert.equal(wideBody.columns, 297, 'the diacritic table bounds the painted body')
  assert.ok(wideBody.rows <= 297)
  assert.equal(wide.length, wideBody.rows)
  assert.ok(wide[0]!.startsWith(`\x1b_pi:tmux-image:v1:i=${image.imageId},p=`),
    'the managed body is marked only after the Core handle exists')
  const anchorAt = wide[0]!.indexOf('\x1b_G')
  assert.ok(anchorAt > 0)
  assert.equal(wide[0]!.slice(anchorAt).startsWith(
    encodeKittyVirtualPlacement(Number(image.imageId), Number(wide[0]!.match(/,p=(\d+)/)?.[1]), wideBody.columns, wideBody.rows),
  ), true)

  image.invalidate()
  const narrow = image.render(40)
  const narrowBody = image.paintedBodyAt(40)!
  assert.ok(narrowBody.columns < wideBody.columns, 'a narrower grant paints fewer columns')
  assert.equal(narrow.length, narrowBody.rows)
  const grid = encodeKittyPlaceholderGrid(image.imageId!, Number(narrow[0]!.match(/,p=(\d+)/)?.[1]), narrowBody.columns, narrowBody.rows)
  assert.ok(narrow[0]!.endsWith(grid[0]!))
  } finally {
    dispose()
  }
})

test('tmux virtual: scrolling into the middle keeps explicit row cells and relocates exactly one anchor', (t) => {
  const h = harness(t)
  try {
    h.terminal.columns = 60
    h.terminal.rows = 10
    const image = imageOf(h.graphics, source(PNG, 100, 500), { maxWidthCells: 20, maxHeightCells: 10, fallback: '[image]' })
    image.render(60)
    const body = image.paintedBodyAt(60)!
    assert.equal(body.rows, 10)
    const grid = encodeKittyPlaceholderGrid(image.imageId!, Number(image.render(60)[0]!.match(/,p=(\d+)/)?.[1]), body.columns, body.rows)

    const content = new LegacyContainer()
    for (let index = 0; index < 3; index++) content.addChild(new LegacyText(`l${index}`, 0, 0))
    content.addChild(image)
    for (let index = 0; index < 20; index++) content.addChild(new LegacyText(`t${index}`, 0, 0))
    const scroll = new LegacyScrollView(content, { primary: true, follow: 'none' })
    const screen = new TuiAltScreen(h.graphics.terminal, undefined, undefined, { mouse: false })
    screen.setLayoutRoot(scroll)
    screen.start()
    screen.renderNow()
    assert.equal(scroll.scrollTop, 0)

    scroll.scrollTo(4)
    image.invalidate()
    content.invalidate()
    h.terminal.writes.length = 0
    screen.renderNow()
    assert.equal(scroll.scrollTop, 4)
    const scan = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(scan)
    const relocated = scan.commands.filter((command) => command.controls.a === 'p' && command.controls.U === '1')
    assert.equal(relocated.length, 1, 'the clipped anchor is relocated exactly once')
    assert.equal(scan.commands.filter((command) => command.controls.a === 't').length, 0,
      'the existing prototype still owns the data')
    assert.equal(scan.commands.filter((command) => command.controls.a === 'd').length, 0)
    const firstVisibleAt = h.terminal.text.indexOf(grid[1]!)
    assert.ok(firstVisibleAt !== -1)
    assert.ok(h.terminal.text.slice(Math.max(0, firstVisibleAt - 200), firstVisibleAt).includes(DCS_INTRODUCER),
      'the relocated anchor immediately precedes the first visible placeholder row')
    for (let row = 1; row < body.rows; row++) {
      assert.ok(scan.text.includes(grid[row]!), `visible image row ${row} keeps its own diacritics`)
    }
    assert.equal(scan.text.includes(grid[0]!), false, 'the anchor row itself is out of view')

    // Scrolling back re-emits the anchor; the data is still resident.
    scroll.scrollTo(0)
    image.invalidate()
    content.invalidate()
    h.terminal.writes.length = 0
    screen.renderNow()
    const restored = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(restored)
    assert.equal(restored.commands.filter((command) => command.controls.a === 'p').length, 1)
    assert.equal(restored.commands.filter((command) => command.controls.a === 't').length, 0,
      're-showing the same cells does not re-upload')
    assert.ok(restored.text.includes(grid[0]!))

    // Bottom clipping: scroll just past the leading text so the anchor is
    // visible while the image is taller than the five-row viewport. The screen
    // must paint only the cells that fit.
    scroll.scrollTo(3)
    image.invalidate()
    content.invalidate()
    h.terminal.rows = 5
    h.terminal.writes.length = 0
    screen.renderNow()
    const clipped = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(clipped)
    for (let row = 0; row < 5; row++) {
      assert.ok(clipped.text.includes(grid[row]!), `visible bottom row ${row}`)
    }
    assert.equal(clipped.text.includes(grid[5]!), false, 'rows below the viewport are never painted')
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('alt screen: the first visible frame relocates the anchor when the image is first mounted mid-scroll', (t) => {
  const h = harness(t)
  try {
    h.terminal.columns = 60
    h.terminal.rows = 10
    const image = imageOf(h.graphics, source(PNG, 100, 500), { maxWidthCells: 20, maxHeightCells: 10, fallback: '[image]' })
    const content = new LegacyContainer()
    for (let index = 0; index < 3; index++) content.addChild(new LegacyText(`l${index}`, 0, 0))
    const slot = new LegacyContainer()
    content.addChild(slot)
    for (let index = 0; index < 20; index++) content.addChild(new LegacyText(`t${index}`, 0, 0))
    const scroll = new LegacyScrollView(content, { primary: true, follow: 'none' })
    const screen = new TuiAltScreen(h.graphics.terminal, undefined, undefined, { mouse: false })
    screen.setLayoutRoot(scroll)
    screen.start()
    screen.renderNow() // first frame: the image slot is still empty, no anchor exists

    slot.addChild(image) // the image is mounted only now, while the view is mid-content
    content.invalidate()
    scroll.scrollTo(4)
    h.terminal.writes.length = 0
    screen.renderNow()

    assert.equal(scroll.scrollTop, 4)
    const scan = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(scan)
    const transmissions = scan.commands.filter((command) => command.controls.a === 't')
    const placements = scan.commands.filter((command) => command.controls.a === 'p' && command.controls.U === '1')
    assert.equal(transmissions.length, 1, 'the first visible frame uploads the image')
    assert.equal(placements.length, 1, 'exactly one placement is created')
    assert.ok(scan.commands.indexOf(transmissions[0]!) < scan.commands.indexOf(placements[0]!),
      'the upload precedes the placement')
    assert.equal(transmissions[0]!.controls.i, placements[0]!.controls.i)
    const body = image.paintedBodyAt(60)
    assert.ok(body !== undefined)
    assert.equal(Number(placements[0]!.controls.c), body.columns)
    assert.equal(Number(placements[0]!.controls.r), body.rows)
    assert.ok(count(scan.text, P) > 0, 'the first visible frame paints placeholder cells')
    const grid = encodeKittyPlaceholderGrid(image.imageId!, Number(placements[0]!.controls.p), body.columns, body.rows)
    const firstVisibleAt = h.terminal.text.indexOf(grid[1]!)
    assert.ok(firstVisibleAt !== -1)
    assert.ok(h.terminal.text.slice(Math.max(0, firstVisibleAt - 200), firstVisibleAt).includes(DCS_INTRODUCER),
      'the first frame carries the anchor directly before its first visible row')
    assert.equal(scan.text.includes(grid[0]!), false, 'the original first row is genuinely clipped')
    assert.equal(scan.commands.filter((command) => command.controls.a === 'd').length, 0)
    assert.equal(h.terminal.text.includes('pi:tmux-image'), false, 'the relocated marker is stripped')
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('alt screen: an overlay over the first visible row does not lose the relocated anchor', (t) => {
  const h = harness(t)
  try {
    h.terminal.columns = 60
    h.terminal.rows = 10
    const image = imageOf(h.graphics, source(PNG, 100, 500), { maxWidthCells: 20, maxHeightCells: 10, fallback: '[image]' })
    const content = new LegacyContainer()
    for (let index = 0; index < 3; index++) content.addChild(new LegacyText(`l${index}`, 0, 0))
    const slot = new LegacyContainer()
    content.addChild(slot)
    for (let index = 0; index < 20; index++) content.addChild(new LegacyText(`t${index}`, 0, 0))
    const scroll = new LegacyScrollView(content, { primary: true, follow: 'none' })
    const screen = new TuiAltScreen(h.graphics.terminal, undefined, undefined, { mouse: false })
    screen.setLayoutRoot(scroll)
    screen.start()
    screen.renderNow()
    slot.addChild(image)
    content.invalidate()
    scroll.scrollTo(4)
    class Overlay implements Component {
      render(): string[] {
        return ['OVERLAY']
      }
      invalidate(): void {}
    }
    screen.showOverlay(new Overlay(), { anchor: 'top-left', width: 10 })
    h.terminal.writes.length = 0
    screen.renderNow()
    const scan = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(scan)
    assert.equal(scan.commands.filter((command) => command.controls.a === 't').length, 1)
    assert.equal(scan.commands.filter((command) => command.controls.a === 'p' && command.controls.U === '1').length, 1,
      'the overlay compositing keeps the relocated anchor')
    assert.ok(count(scan.text, P) > 0)
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('main screen: a long first frame paints its anchor without any clipping seam', (t) => {
  const h = harness(t)
  try {
    h.terminal.columns = 60
    h.terminal.rows = 10
    const image = imageOf(h.graphics, source(PNG, 100, 500), { maxWidthCells: 20, maxHeightCells: 10, fallback: '[image]' })
    class LongRoot implements Component {
      render(width: number): string[] {
        const lines: string[] = []
        for (let index = 0; index < 50; index++) lines.push(`lead ${index}`)
        lines.push(...image.render(width))
        lines.push('END')
        return lines
      }
      invalidate(): void {
        image.invalidate()
      }
    }
    const screen = new TuiMainScreen(h.graphics.terminal)
    screen.addChild(new LongRoot())
    screen.start()
    h.terminal.writes.length = 0
    screen.renderNow()
    const scan = scanOuter(h.terminal.text)
    assertNoUnwrappedGraphics(scan)
    assert.equal(scan.commands.filter((command) => command.controls.a === 't').length, 1)
    assert.equal(scan.commands.filter((command) => command.controls.a === 'p' && command.controls.U === '1').length, 1,
      'the main writer paints the anchor on its own row, so no relocation is needed')
    assert.equal(h.terminal.text.includes('pi:tmux-image'), false, 'the Main path strips the marker through the facade')
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('tmux virtual: the provenance marker never reaches the terminal across split writes', (t) => {
  const h = harness(t)
  try {
    const image = imageOf(h.graphics, source(), fallbackOptions())
    const line = image.render(80)[0]!
    const prefix = '\x1b_pi:tmux-image:v1:i='
    assert.ok(line.startsWith(prefix), 'the managed component really marks its anchor line')
    const markerEnd = line.indexOf('\x1b\\', prefix.length) + 2
    const marker = line.slice(0, markerEnd)
    for (let cut = 1; cut <= marker.length; cut++) {
      const single = directFacade(t)
      try {
        const anchored = new TmuxKittyImage(single.core, source(), fallbackOptions(), single.admission)
        const anchoredLine = anchored.render(80)[0]!
        single.terminal.writes.length = 0
        single.facade.write(anchoredLine.slice(0, cut))
        single.facade.write(anchoredLine.slice(cut))
        assert.equal(single.terminal.text.includes('pi:tmux-image'), false,
          `no marker leaks when split at ${cut}`)
        assert.ok(single.terminal.text.includes('\x1bPtmux;') || single.terminal.text.includes('\x1b_G'),
          `the real anchor survives split ${cut}`)
      } finally {
        single.dispose()
      }
    }
  } finally {
    h.dispose()
  }
})

test('alt screen: a complete foreign virtual image is never relocated', (t) => {
  const h = harness(t)
  try {
    h.terminal.columns = 60
    h.terminal.rows = 10
    const foreignId = 0x345678
    const foreignAnchor = encodeKittyVirtualPlacement(foreignId, 1, 4, 3)
    const foreignGrid = encodeKittyPlaceholderGrid(foreignId, 1, 4, 3)
    class ForeignImage implements Component {
      render(): string[] {
        return [foreignAnchor + foreignGrid[0]!, ...foreignGrid.slice(1)]
      }
      invalidate(): void {}
    }
    const content = new LegacyContainer()
    for (let index = 0; index < 3; index++) content.addChild(new LegacyText(`l${index}`, 0, 0))
    content.addChild(new ForeignImage())
    for (let index = 0; index < 20; index++) content.addChild(new LegacyText(`t${index}`, 0, 0))
    const scroll = new LegacyScrollView(content, { primary: true, follow: 'none' })
    const screen = new TuiAltScreen(h.graphics.terminal, undefined, undefined, { mouse: false })
    screen.setLayoutRoot(scroll)
    screen.start()
    screen.renderNow()
    scroll.scrollTo(4)
    content.invalidate()
    h.terminal.writes.length = 0
    screen.renderNow()
    const scan = scanOuter(h.terminal.text)
    assert.equal(scan.commands.length, 0, 'the foreign anchor is not invented or moved')
    assert.ok(count(scan.text, P) > 0, 'the foreign placeholder cells are painted unchanged')
    assert.equal(h.terminal.text.includes('pi:tmux-image'), false)
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('tmux virtual: a client change between the retirement batch and the frame batch refuses the frame', (t) => {
  const cli = createFakeTmuxCli(t)
  const terminal = new RecordingTerminal()
  const identity = probeTmuxKittyIdentity(cli.env)
  assert.ok(identity)
  const admission = new TmuxKittyAdmission(identity, cli.env)
  const core = new KittyGraphicsCore({ placementMode: 'tmux-virtual' })
  const facade = new KittyTerminalFacade(terminal, core, { placementMode: 'tmux-virtual', admission })
  try {
    const pending = new TmuxKittyImage(core, source(), fallbackOptions(), admission)
    pending.render(80) // registered, never offered to a screen
    pending.dispose() // queued never-painted retirement
    const painted = new TmuxKittyImage(core, source(), fallbackOptions(), admission)
    const anchor = painted.render(80)[0]!
    assert.ok(core.hasQueuedRetirements())

    // The sink observes the client change exactly during the retirement batch,
    // i.e. between the two physical writes of this one facade call.
    let writes = 0
    const originalWrite = terminal.write.bind(terminal)
    terminal.write = (data: string) => {
      originalWrite(data)
      writes += 1
      if (writes === 1) cli.setReply('show-options', { text: 'off\n' })
    }
    assert.throws(() => facade.write(anchor), TmuxGraphicsRevokedError)

    const scan = scanOuter(terminal.text)
    assert.equal(writes, 1, 'the retirement batch was the only physical write')
    assert.equal(scan.commands.some((command) => command.controls.a === 'p'), false,
      'no placement reached the changed client')
    assert.equal(scan.commands.some((command) => command.controls.a === 't'), false,
      'no transmission reached the changed client')
    assert.equal(count(scan.text, P), 0, 'no placeholder cell reached the changed client')
    assert.equal(scan.commands.length, 1, 'only the already-admitted retirement batch was written')
    assert.equal(scan.commands[0]!.controls.d, 'I')
    assert.equal(admission.isAllowed(true), false, 'the latch is permanent')
  } finally {
    facade.dispose()
    core.dispose()
    cli.dispose()
  }
})

test('tmux virtual: a revoked image component fallback wins over a queued unpainted retirement', (t) => {
  const h = harness(t)
  try {
    const painted = imageOf(h.graphics, source(), fallbackOptions())
    const anchor = painted.render(100)[0]!
    h.graphics.terminal.write(anchor)
    const pending = imageOf(h.graphics, source(), fallbackOptions())
    pending.render(100) // registered, never offered
    pending.dispose() // queued retirement
    h.cli.setReply('show-options', { text: 'off\n' })
    assert.throws(() => h.graphics.terminal.write(anchor), TmuxGraphicsRevokedError,
      'the forced managed write latches the revocation and drops the queued retirement')
    h.terminal.writes.length = 0
    const fallback = painted.render(100)
    assert.deepEqual(fallback, ['[fallback]'], 'the same image component really paints its fallback')
    h.graphics.terminal.write(fallback.join('\r\n'))
    assert.equal(h.terminal.text, '[fallback]', 'the fallback frame is written after the retirement is dropped')
    assert.equal(h.terminal.text.includes('\x1b_G'), false)
    assert.equal(count(h.terminal.text, P), 0)
  } finally {
    h.dispose()
  }
})

test('tmux virtual: dispose is idempotent and a factory handle owns exactly one Core lifetime', (t) => {
  const h = harness(t)
  try {
    const image = imageOf(h.graphics, source(), fallbackOptions())
    const anchor = image.render(80)
    h.graphics.terminal.write(anchor.join('\r\n'))
    assert.equal(h.graphics.mode, 'tmux-virtual')
    assert.equal(h.graphics.canPaint(), true)
    h.graphics.dispose()
    h.graphics.dispose()
  } finally {
    h.dispose()
  }
})

/**
 * A user may set `PI_IMAGE_PROTOCOL=kitty`, which makes the fork's screens
 * believe they have a Native Kitty capability inside tmux. The virtual gate
 * must still suppress the fork's global cleanup: that global form has no
 * virtual location and must never reach the outer terminal.
 */
test('the fork Kitty capability in a tmux pane never lets a global cleanup escape', (t) => {
  const cli = createFakeTmuxCli(t)
  const terminal = new RecordingTerminal()
  const graphics = createTmuxKittyGraphics(terminal, {}, cli.env)
  assert.ok(graphics)
  try {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
    const image = imageOf(graphics, source(), fallbackOptions())
    class Root implements Component {
      render(width: number): string[] {
        return ['head', ...image.render(width), 'tail']
      }
      invalidate(): void {
        image.invalidate()
      }
    }

    // Main screen: a width change triggers the fork's full redraw, including
    // its per-id cleanup for the managed anchor.
    const main = new TuiMainScreen(graphics.terminal)
    main.addChild(new Root())
    main.start()
    main.renderNow()
    terminal.writes.length = 0
    terminal.columns = 70
    main.renderNow()
    const mainScan = scanOuter(terminal.text)
    assertNoUnwrappedGraphics(mainScan)
    assert.equal(mainScan.commands.some((command) => command.controls.a === 'd'), false,
      'the fork per-id cleanup is layout intent only')

    // Alt screen: its Kitty-only `beforeTerminalStop` global delete is the most
    // dangerous form; the replay after ?1049l must still own the image.
    const alt = new TuiAltScreen(graphics.terminal, undefined, undefined, { mouse: false })
    alt.addChild(new Root())
    alt.start()
    alt.renderNow()
    terminal.writes.length = 0
    alt.stop({ preserveScreen: false })
    const altScan = scanOuter(terminal.text)
    assertNoUnwrappedGraphics(altScan)
    assert.equal(altScan.commands.some((command) => command.controls.a === 'd'), false,
      'no global or scoped delete escapes the virtual gate')
    const exitAt = terminal.text.lastIndexOf('\x1b[?1049l')
    assert.ok(exitAt !== -1)
    assert.ok(count(terminal.text.slice(exitAt), P) > 0, 'the replay still paints the grid')
    assert.equal(altScan.commands.filter((command) => command.controls.a === 't').length, 0,
      'the payload is still resident across the stop')
  } finally {
    graphics.dispose()
    cli.dispose()
    setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  }
})

test('tmux virtual: a frame larger than one writer chunk paints its grid across physical writes', (t) => {
  // The real `TuiMainScreen` flushes one frame in 1 MiB physical chunks. A
  // managed image whose rows land in a LATER chunk must still paint: the grid is
  // text, not a placement, so the success path has to survive the split.
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const h = harness(t)
  setCellDimensions({ widthPx: 9, heightPx: 18 })
  try {
    const image = imageOf(h.graphics, source(PNG, 3200, 2400), {
      maxWidthCells: 150,
      maxHeightCells: 40,
      fallback: '[fallback]',
    })
    class BigRoot implements Component {
      private readonly imageRows = image.render(100)
      render(width: number): string[] {
        return [
          ...Array.from({ length: 12000 }, (_, index) => `pad ${index} ${'z'.repeat(740)}`),
          ...this.imageRows,
        ]
      }
      invalidate(): void {
        image.invalidate()
      }
    }
    const screen = new TuiMainScreen(h.graphics.terminal)
    screen.addChild(new BigRoot())
    screen.start()
    screen.renderNow()
    const text = h.terminal.text
    const chunks = h.terminal.writes.length
    assert.ok(chunks >= 2, `the frame must really split across physical writes, got ${chunks}`)
    // Record WHERE the anchor and the grid actually landed, so a "pass" can
    // never come from a single-chunk frame that happened to contain both.
    const perChunk = h.terminal.writes.map((write, index) => ({
      index,
      anchor: write.includes('a=p'),
      cells: count(write, P),
    }))
    const anchorChunks = perChunk.filter(entry => entry.anchor).map(entry => entry.index)
    const gridChunks = perChunk.filter(entry => entry.cells > 0).map(entry => entry.index)
    assert.equal(anchorChunks.length, 1, `the anchor must be written exactly once: ${JSON.stringify(perChunk)}`)
    assert.ok(gridChunks.length >= 1, 'the grid reached the sink')
    const scan = scanOuter(text)
    assert.equal(scan.commands.filter(command => command.controls.a === 't').length, 1,
      'exactly ONE managed transmission for the frame')
    assert.equal(scan.commands.filter(command => command.controls.a === 'p' && command.controls.U === '1').length, 1,
      'exactly ONE virtual placement')
    // The viewport clips the placement (the image is tall, the screen is 40 rows),
    // so assert the exact number of cells the component painted at its own width
    // rather than the unclipped geometry.
    const painted = image.paintedBodyAt(100)
    assert.ok(painted !== undefined, 'the component reported its painted body at its render width')
    assert.equal(count(scan.text, P), painted.columns * painted.rows,
      `every painted cell must reach the sink, got ${count(scan.text, P)} of ${painted.columns * painted.rows}`)
    screen.stop()
  } finally {
    h.dispose()
  }
})

test('tmux virtual: a revocation between writer chunks refuses every later placeholder chunk', (t) => {
  // The refusal has to hold for a PUA-ONLY physical chunk, i.e. one that carries
  // grid cells but NO `a=p`. Without that, a revocation in the middle of a
  // frame would leak the old image's cells to a different client.
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const h = harness(t)
  setCellDimensions({ widthPx: 9, heightPx: 18 })
  try {
    const image = imageOf(h.graphics, source(PNG, 3200, 2400), {
      maxWidthCells: 150,
      maxHeightCells: 40,
      fallback: '[fallback]',
    })
    const rows = image.render(190)
    assert.ok(rows.length > 1, 'fixture: the image really paints several grid rows')
    const anchor = rows[0]!
    const grid = rows.slice(1).join('\r\n')
    assert.ok(anchor.includes('a=p'), 'fixture: the first row carries the placement')
    assert.equal(grid.includes('a=p'), false, 'fixture: the remaining rows carry NO placement')
    assert.ok(grid.includes(P), 'fixture: the remaining rows are placeholder cells')

    h.graphics.terminal.write(anchor)
    const before = h.terminal.text
    assert.ok(before.includes('a=p'), 'the admitted anchor reached the sink')

    h.cli.setReply('list-clients', { text: '' })
    assert.throws(() => h.graphics.terminal.write(grid), TmuxGraphicsRevokedError,
      'a PUA-only managed batch must be refused once the admission is revoked')
    assert.equal(h.terminal.text, before, 'the refused grid emitted nothing at all')

    // NEGATIVE CONTROL: the NEXT frame is where the forced repaint paints text.
    // A frame start clears the refused-frame latch, and an ordinary line that
    // happens to contain the SAME `U+10EEEE` code point must be written.
    h.graphics.terminal.write('\x1b[?2026h')
    const plain = `plain user text with ${P} inside`
    h.graphics.terminal.write(plain)
    assert.equal(h.terminal.text.endsWith(plain), true,
      'plain text containing U+10EEEE must still be written after a revocation')
  } finally {
    h.dispose()
  }
})

test('tmux virtual: a chunk cut INSIDE a grid row is refused as a continuation', (t) => {
  // The fork's 1 MiB writer only avoids splitting surrogate pairs: it can cut a
  // grid row AFTER that row's colour prefix and inside its placeholder cells.
  // The tail then carries cells but no colours of its own, so the facade must
  // attribute it to the row that was still open.
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const h = harness(t)
  setCellDimensions({ widthPx: 9, heightPx: 18 })
  try {
    const image = imageOf(h.graphics, source(PNG, 3200, 2400), {
      maxWidthCells: 150,
      maxHeightCells: 40,
      fallback: '[fallback]',
    })
    const rows = image.render(190)
    const anchor = rows[0]!
    const row = rows[1]!
    const cut = row.indexOf(P) + 40
    assert.ok(cut > 40 && cut < row.length, 'fixture: the cut is inside a placeholder run')
    const head = row.slice(0, cut)
    const tail = row.slice(cut)
    assert.ok(head.includes('38;2;'), 'fixture: the head carries the row colour prefix')
    assert.equal(tail.includes('38;2;'), false, 'fixture: the tail carries cells but NO colours')
    assert.ok(tail.includes(P), 'fixture: the tail really carries placeholder cells')

    h.graphics.terminal.write(anchor)
    h.graphics.terminal.write(head)
    const before = h.terminal.text
    h.cli.setReply('list-clients', { text: '' })
    assert.throws(() => h.graphics.terminal.write(tail), TmuxGraphicsRevokedError,
      'a mid-row continuation must be refused after the revocation')
    assert.equal(h.terminal.text, before, 'the refused continuation emitted nothing')
  } finally {
    h.dispose()
  }
})

test('tmux virtual: a REAL 1 MiB writer cut inside the grid leaks no cell on revocation', (t) => {
  // Construction, not calibration: four maximum-size grids (~370 KB each) put
  // the fork's 1 MiB chunk boundary INSIDE one of them on any terminal, so the
  // second physical chunk begins with placeholder cells and no colour prefix.
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  setCellDimensions({ widthPx: 9, heightPx: 18 })
  const h = harness(t)
  const WIDTH = 1200
  h.terminal.columns = WIDTH
  try {
    const build = (revokeAfterFirstWrite = false): {
      calls: string[]
      text: string
      graphics: NonNullable<ReturnType<typeof createTmuxKittyGraphics>>
      screen: TuiMainScreen
      thrown: unknown
    } => {
      const sink = new RecordingTerminal()
      sink.columns = WIDTH
      const graphics = createTmuxKittyGraphics(sink, {}, h.cli.env)
      assert.ok(graphics)
      const images = Array.from({ length: 8 }, () => imageOf(graphics, source(PNG, 3200, 2400), {
        maxWidthCells: 297,
        maxHeightCells: 297,
        fallback: '[fallback]',
      }))
      class Root implements Component {
        private readonly rows = images.flatMap(image => image.render(WIDTH))
        render(): string[] {
          return this.rows
        }
        invalidate(): void {
          for (const image of images) image.invalidate()
        }
      }
      const screen = new TuiMainScreen(graphics.terminal)
      screen.addChild(new Root())
      screen.start()
      const calls: string[] = []
      const original = graphics.terminal.write.bind(graphics.terminal)
      ;(graphics.terminal as { write: (data: string) => void }).write = (data: string): void => {
        calls.push(data)
        original(data)
      }
      if (revokeAfterFirstWrite) {
        let fired = false
        const sinkWrite = sink.write.bind(sink)
        sink.write = (data: string): void => {
          sinkWrite(data)
          if (!fired) {
            fired = true
            h.cli.setReply('list-clients', { text: '' })
          }
        }
      }
      let thrown: unknown
      try {
        screen.renderNow()
      } catch (error) {
        thrown = error
      }
      return { calls, text: sink.text, graphics, screen, thrown }
    }

    const real = build()
    const calls = real.calls
    assert.ok(calls.length >= 2, `the frame must split into at least two physical writes, got ${calls.length}`)
    const first = calls[0]!
    const second = calls[1]!
    assert.ok(first.includes(P) && !first.endsWith('\n'), 'chunk 1 ends inside a grid row')
    const secondHead = second.split('\n')[0]!
    assert.ok(secondHead.includes(P), 'chunk 2 begins with placeholder cells')
    assert.equal(secondHead.includes('38;2;'), false, 'chunk 2 begins WITHOUT a colour prefix')
    real.screen.stop()
    real.graphics.dispose()

    // Fresh screen on the SAME construction: revoke after the first write.
    const finalRun = build(true)
    assert.ok(finalRun.calls.length >= 2, 'the revoking run also split physically')
    const refusedHead = finalRun.calls[0]!
    assert.ok(refusedHead.includes(P) && !refusedHead.endsWith('\n'),
      'the first write of the revoking run also ends inside a grid row')
    assert.equal(finalRun.thrown instanceof TmuxGraphicsRevokedError, true,
      `the mid-row continuation must be refused, got ${String(finalRun.thrown)}`)
    assert.equal((finalRun.text.match(new RegExp(P, 'gu')) ?? []).length,
      (refusedHead.match(new RegExp(P, 'gu')) ?? []).length,
      'no cell beyond the first (pre-revocation) chunk reached the sink')
    finalRun.screen.stop()
    finalRun.graphics.dispose()
  } finally {
    h.dispose()
  }
})


test('tmux virtual: plain text that visually mimics a grid cell stays ordinary text', (t) => {
  // The grid is delimited by PROVENANCE — a Core-owned `a=p,U=1` anchor and its
  // own `r=` row budget — not by what the bytes look like. A legal text line can
  // carry the placeholder base plus three diacritics from the same table; with no
  // managed anchor open it must still be written, even on a revoked handle.
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const h = harness(t)
  setCellDimensions({ widthPx: 9, heightPx: 18 })
  try {
    const mimic = `${P}\u0305\u030d\u030e` // base + three table diacritics
    const line = `ordinary text ${mimic} continues`
    h.cli.setReply('list-clients', { text: '' })
    h.graphics.terminal.write(line)
    assert.equal(h.terminal.text.endsWith(line), true,
      'a cell-looking plain text line must still be written after a revocation')
  } finally {
    h.dispose()
  }
})

test('tmux virtual: a chunk holding only a cell BASE is still refused as managed', (t) => {
  // The 1 MiB writer can cut between a cell's base and its diacritics. While the
  // anchor's row budget is open, a chunk that holds only the base still belongs
  // to the managed grid and must be refused.
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const h = harness(t)
  setCellDimensions({ widthPx: 9, heightPx: 18 })
  try {
    const image = imageOf(h.graphics, source(PNG, 3200, 2400), {
      maxWidthCells: 150,
      maxHeightCells: 40,
      fallback: '[fallback]',
    })
    const rows = image.render(190)
    const row = rows[1]!
    const baseAt = row.indexOf(P, row.indexOf(P) + 1) // the SECOND cell's base
    assert.ok(baseAt > 0, 'fixture: a later cell exists')
    h.graphics.terminal.write(rows[0]!) // anchor: opens the row budget
    h.graphics.terminal.write(row.slice(0, baseAt)) // prefix ending BEFORE the base
    const before = h.terminal.text
    h.cli.setReply('list-clients', { text: '' })
    const baseOnly = row.slice(baseAt, baseAt + P.length)
    assert.equal(baseOnly, P, 'fixture: the chunk is exactly one placeholder base')
    assert.throws(() => h.graphics.terminal.write(baseOnly), TmuxGraphicsRevokedError,
      'a base-only chunk inside the anchor budget must be refused')
    assert.equal(h.terminal.text, before, 'and it emitted nothing')
  } finally {
    h.dispose()
  }
})

test('tmux virtual: chunks AFTER the first refusal in the same frame stay refused', (t) => {
  // The app boundary turns a refusal into a next-tick repaint, but the fork
  // writer keeps flushing the SAME frame in the meantime. Every later chunk that
  // still carries cells belongs to the refused image and must be refused too.
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const h = harness(t)
  setCellDimensions({ widthPx: 9, heightPx: 18 })
  try {
    const image = imageOf(h.graphics, source(PNG, 3200, 2400), {
      maxWidthCells: 150,
      maxHeightCells: 40,
      fallback: '[fallback]',
    })
    const rows = image.render(190)
    h.graphics.terminal.write(rows[0]!)
    h.graphics.terminal.write(rows[1]!)
    const before = h.terminal.text
    h.cli.setReply('list-clients', { text: '' })
    assert.throws(() => h.graphics.terminal.write(rows[2]!), TmuxGraphicsRevokedError,
      'the first refused chunk')
    assert.throws(() => h.graphics.terminal.write(rows[3]!), TmuxGraphicsRevokedError,
      'a LATER chunk of the same frame must stay refused')
    assert.throws(() => h.graphics.terminal.write(rows.slice(4).join('\r\n')), TmuxGraphicsRevokedError,
      'and the frame stays refused to its end')
    assert.equal(h.terminal.text, before, 'no cell of the refused frame reached the sink')
  } finally {
    h.dispose()
  }
})

test('tmux virtual: ordinary text after a 1-row grid ends is NOT classified as managed', (t) => {
  // A one-row image owes exactly one line. Once that line ends, the budget is
  // spent: a following text line containing the placeholder codepoint belongs to
  // the user, even on a revoked handle.
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const h = harness(t)
  setCellDimensions({ widthPx: 9, heightPx: 18 })
  try {
    const image = imageOf(h.graphics, source(PNG, 320, 18), {
      maxWidthCells: 20,
      maxHeightCells: 1,
      fallback: '[fallback]',
    })
    const rows = image.render(80)
    assert.equal(rows.length, 1, 'fixture: the image really is one row tall')
    h.graphics.terminal.write(rows[0]!)
    h.cli.setReply('list-clients', { text: '' })
    const line = `\r\nordinary text with ${P} inside`
    h.graphics.terminal.write(line)
    assert.equal(h.terminal.text.endsWith(line), true,
      'the user line after the spent budget must still be written')
  } finally {
    h.dispose()
  }
})

test('tmux virtual: a differential frame rewriting ONLY a non-anchor grid row is refused', (t) => {
  // `TuiAltScreen` diffs by changed rows and addresses each one absolutely. A
  // frame may therefore contain a single grid row with NO anchor. The row's own
  // provenance marker is what keeps it managed.
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const h = harness(t)
  setCellDimensions({ widthPx: 9, heightPx: 18 })
  try {
    const image = imageOf(h.graphics, source(PNG, 3200, 2400), {
      maxWidthCells: 150,
      maxHeightCells: 40,
      fallback: '[fallback]',
    })
    const rows = image.render(190)
    h.graphics.terminal.write(rows.join('\r\n'))
    const before = h.terminal.text
    h.cli.setReply('list-clients', { text: '' })
    // The exact ALT-diff shape: new synchronised frame, absolute cursor, clear
    // line, ONE changed grid row (no anchor), end of frame.
    const frame = `\x1b[?2026h\x1b[5;1H\x1b[2K${rows[1]!}\x1b[?2026l`
    assert.throws(() => h.graphics.terminal.write(frame), TmuxGraphicsRevokedError,
      'an anchor-less differential grid row must be refused')
    assert.equal(h.terminal.text, before, 'the differential frame emitted nothing')
  } finally {
    h.dispose()
  }
})

test('tmux virtual: a cut INSIDE the anchor row cells is still proved by that row marker', (t) => {
  // Row 0 carries the anchor, but a 1 MiB boundary can fall INSIDE its own grid
  // cells: the continuation has no anchor. Row 0 therefore carries a per-row
  // marker as well, so the tail is still recognised as managed.
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const h = harness(t)
  setCellDimensions({ widthPx: 9, heightPx: 18 })
  try {
    const image = imageOf(h.graphics, source(PNG, 3200, 2400), {
      maxWidthCells: 150,
      maxHeightCells: 40,
      fallback: '[fallback]',
    })
    const row0 = image.render(190)[0]!
    const firstCell = row0.indexOf(P)
    assert.ok(firstCell > 0, 'fixture: row 0 really carries cells')
    const cut = firstCell + 40
    const head = row0.slice(0, cut)
    const tail = row0.slice(cut)
    assert.ok(tail.includes(P), 'fixture: the tail carries cells')
    h.graphics.terminal.write(head)
    const before = h.terminal.text
    h.cli.setReply('list-clients', { text: '' })
    assert.throws(() => h.graphics.terminal.write(tail), TmuxGraphicsRevokedError,
      'a cut inside the anchor row must still be refused')
    assert.equal(h.terminal.text, before, 'the refused tail emitted nothing')
  } finally {
    h.dispose()
  }
})
