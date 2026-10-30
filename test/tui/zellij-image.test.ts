/**
 * Image-7C-3 — Zellij admission, probe input and Native writer (generalized
 * by Image-7C from a Ghostty-host-only candidate to a live-pane capability
 * query on every host).
 *
 * These cases own the Zellij-specific production boundary: the environment
 * candidate, the one-way live-pane admission and the facade subclass that
 * consumes only this probe's reply. The same Native Core/Facade/component path
 * is exercised through the real factory; the cross-owner TuiApp composition is
 * covered in `test/integration/kitty-zellij-screen.test.ts`.
 *
 * Evidence level: a recording `Terminal` sink supplies the physical bytes; the
 * probe answer is test-fed. This is E2 (real factory + real writer), never the
 * real Zellij GUI E3.
 * @module @xmoon76/dsh-pi-tui/tui/zellij-image.test
 */

import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import {
  StdinBuffer,
  resetCapabilitiesCache,
  setCapabilities,
  type Terminal,
  type TerminalProgressState,
} from '@xmoon76/pi-tui'
import {
  ZELLIJ_PROBE_TIMEOUT_MS,
  candidateZellijKitty,
  createZellijKittyGraphics,
  zellijProbeWire,
} from '../../src/tui/graphics/zellij-image.ts'
import {
  ZELLIJ_SIXEL_DA1_TIMEOUT_MS,
  createZellijNegotiatedGraphics,
  zellijVersionEligible,
  type ZellijNegotiatedGraphics,
} from '../../src/tui/graphics/zellij-sixel.ts'
import { effectiveImageProtocol } from '../../src/tui/graphics/image-capability.ts'
import { createDirectSixelGraphics, type SixelScreenObservation } from '../../src/tui/graphics/sixel-image.ts'
import { parseKittyApc } from '../../src/tui/graphics/kitty-native.ts'
import type { KittyGraphics, PixelBody } from '../../src/tui/graphics/native-image.ts'
import { createFakeZellijCli, type FakeZellijCli } from '../support/fake-zellij-cli.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function probeIdOf(terminal: RecordingTerminal): string {
  const matches = [...terminal.text.matchAll(/a=q,i=(\d+)/g)]
  assert.ok(matches.length > 0, 'the facade sent a probe query')
  return matches.at(-1)![1]!
}

function probeReply(terminal: RecordingTerminal, payload = 'OK'): string {
  return `\x1b_Gi=${probeIdOf(terminal)};${payload}\x1b\\`
}

/** One complete primary DA1 reply; attribute 4 is the only SIXEL evidence. */
function primaryDa1(supported: boolean): string {
  return supported ? '\x1b[?4;1;2c' : '\x1b[?1;2c'
}

/** A sink that records every byte the facade offered it and exposes its input handler. */
class RecordingTerminal implements Terminal {
  readonly writes: string[] = []
  columns = 100
  rows = 40
  kittyProtocolActive = false
  /** When set, a matching write throws AFTER recording the bytes. */
  failWhen: ((data: string) => boolean) | undefined
  private onInput: ((data: string) => void) | undefined
  private readonly sixelListeners = new Set<(supported: boolean) => void>()
  private lastSixelSupport: boolean | undefined

  get text(): string {
    return this.writes.join('')
  }

  /**
   * Passive DA1 observation with the production parser's dedupe: only a
   * CHANGED answer notifies. `declareSixel` always forwards the reply bytes,
   * exactly like `ProcessTerminal`, so a same-value re-query reply reaches the
   * facade input wrapper without a listener call.
   */
  onSixelSupport(listener: (supported: boolean) => void): () => void {
    this.sixelListeners.add(listener)
    if (this.lastSixelSupport !== undefined) listener(this.lastSixelSupport)
    return () => {
      this.sixelListeners.delete(listener)
    }
  }

  /** Emit one complete primary DA1 reply through the real input path. */
  declareSixel(supported: boolean): void {
    const changed = this.lastSixelSupport !== supported
    this.lastSixelSupport = supported
    if (changed) for (const listener of [...this.sixelListeners]) listener(supported)
    this.sendInput(primaryDa1(supported))
  }

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.onInput = onInput
  }

  stop(): void {
    this.onInput = undefined
  }

  sendInput(data: string): void {
    this.onInput?.(data)
  }

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

/** One explicit Zellij pane environment; host hints are overridden per case. */
function zellijEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    TERM: 'xterm-256color',
    TERM_PROGRAM: 'ghostty',
    ZELLIJ: '0',
    ZELLIJ_SESSION_NAME: 'itest',
    ...overrides,
  }
}

interface FactoryResult {
  readonly graphics: KittyGraphics
  readonly terminal: RecordingTerminal
  readonly allowed: () => number
}

/** Create the factory over a recording sink and count its `onAllowed` callbacks. */
function admittedFactory(environment: NodeJS.ProcessEnv = zellijEnvironment()): FactoryResult {
  const terminal = new RecordingTerminal()
  let allowed = 0
  const graphics = createZellijKittyGraphics(terminal, {}, environment, () => { allowed += 1 })
  assert.ok(graphics, 'the fixture environment must produce the Zellij factory')
  return { graphics, terminal, allowed: () => allowed }
}

function apcs(text: string): ReturnType<typeof parseKittyApc>[] {
  const found: ReturnType<typeof parseKittyApc>[] = []
  let index = 0
  for (;;) {
    const start = text.indexOf('\x1b_G', index)
    if (start === -1) break
    const end = text.indexOf('\x1b\\', start + 3)
    if (end === -1) break
    const parsed = parseKittyApc(text.slice(start, end + 2))
    if (parsed !== undefined) found.push(parsed)
    index = end + 2
  }
  return found
}

beforeEach(() => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
})

afterEach(() => {
  resetCapabilitiesCache()
})

test('every Zellij host and static capability class creates a pending handle and queries only after start', () => {
  const hosts: ReadonlyArray<readonly [string, Record<string, string | undefined>]> = [
    ['Ghostty host', { TERM_PROGRAM: 'ghostty' }],
    ['WezTerm host', { TERM_PROGRAM: 'wezterm', WEZTERM_PANE: '7' }],
    ['Kitty host', { TERM_PROGRAM: 'kitty' }],
    ['Warp host', { TERM_PROGRAM: 'warpterminal', WARP_SESSION_ID: 'warp-1' }],
    ['Tern host', { TERM_PROGRAM: 'tern' }],
    ['unknown host', { TERM_PROGRAM: 'some-future-terminal' }],
    ['no host hint', {}],
    ['tmux-named TERM without a tmux session', { TERM: 'tmux-256color' }],
  ]
  for (const [hostName, hint] of hosts) {
    for (const marker of ['0', '1'] as const) {
      for (const capability of ['kitty', 'iterm2', null] as const) {
        resetCapabilitiesCache()
        setCapabilities({ images: capability, trueColor: true, hyperlinks: false })
        const environment = zellijEnvironment({ ...hint, ZELLIJ: marker, ZELLIJ_SESSION_NAME: undefined })
        const label = `${hostName} ZELLIJ=${marker} fork images=${capability ?? 'null'}`
        assert.equal(candidateZellijKitty(environment), true, `${label}: the live pane is the admission authority`)
        const terminal = new RecordingTerminal()
        const graphics = createZellijKittyGraphics(terminal, {}, environment, () => {})
        assert.ok(graphics, `${label}: the candidate factory exists`)
        assert.equal(terminal.writes.length, 0, `${label}: zero bytes before start`)
        graphics.terminal.start(() => {}, () => {})
        assert.equal((terminal.text.match(/a=q,/g) ?? []).length, 1, `${label}: exactly one live query after start`)
        assert.equal(
          terminal.text.includes('a=t') || terminal.text.includes('a=p'),
          false,
          `${label}: no image work before the live answer`,
        )
        graphics.dispose()
      }
    }
  }
})

test('hard off and explicit nested multiplexers create no handle and write no query', () => {
  const cases: ReadonlyArray<{ name: string; environment: NodeJS.ProcessEnv }> = [
    { name: 'ZELLIJ unset', environment: zellijEnvironment({ ZELLIJ: undefined }) },
    { name: 'ZELLIJ empty', environment: zellijEnvironment({ ZELLIJ: '' }) },
    { name: 'TMUX nested', environment: zellijEnvironment({ TMUX: '/tmp/tmux,1,0' }) },
    { name: 'STY nested', environment: zellijEnvironment({ STY: 'screen-1' }) },
    { name: 'PI_IMAGE_PROTOCOL=none', environment: zellijEnvironment({ PI_IMAGE_PROTOCOL: 'none' }) },
    { name: 'PI_IMAGE_PROTOCOL=0', environment: zellijEnvironment({ PI_IMAGE_PROTOCOL: '0' }) },
    { name: 'PI_IMAGE_PROTOCOL=iterm2', environment: zellijEnvironment({ PI_IMAGE_PROTOCOL: 'iterm2' }) },
  ]
  for (const entry of cases) {
    const terminal = new RecordingTerminal()
    assert.equal(candidateZellijKitty(entry.environment), false, entry.name)
    assert.equal(
      createZellijKittyGraphics(terminal, {}, entry.environment, () => {}),
      undefined,
      `${entry.name}: no Core/facade/handle`,
    )
    assert.equal(terminal.writes.length, 0, `${entry.name}: no probe write`)
  }
})

test('the real facade sends exactly one probe after start and only the matching OK promotes once', async () => {
  const { graphics, terminal, allowed } = admittedFactory()
  const input: string[] = []
  graphics.terminal.start((data) => input.push(data), () => {})
  assert.equal(terminal.writes.length, 1, 'one physical write')
  const probeId = probeIdOf(terminal)
  assert.equal(terminal.writes[0], zellijProbeWire(Number(probeId)), 'the exact official-shape a=q query')
  assert.equal((terminal.text.match(/a=q,/g) ?? []).length, 1, 'exactly one query')
  assert.equal(graphics.canPaint(), false, 'no pixels before the live answer')

  terminal.sendInput(probeReply(terminal))
  assert.equal(graphics.canPaint(), true, 'the matching OK promotes')
  await Promise.resolve()
  assert.equal(allowed(), 1, 'the render callback fires exactly once')
  assert.deepEqual(input, [], 'the probe reply never reaches the editor')

  terminal.sendInput(probeReply(terminal))
  await Promise.resolve()
  assert.equal(allowed(), 1, 'a duplicate OK never promotes twice')
  assert.deepEqual(input, [], 'a duplicate reply is still consumed')

  terminal.sendInput('\x1b_Gi=424242;OK\x1b\\')
  assert.deepEqual(input, ['\x1b_Gi=424242;OK\x1b\\'], 'a foreign-id APC reaches the screen untouched')
})

test('the same facade transmits once, then re-places the same id without a second upload', () => {
  const { graphics, terminal } = admittedFactory()
  graphics.terminal.start(() => {}, () => {})
  terminal.sendInput(probeReply(terminal))
  terminal.writes.length = 0

  const component = graphics.image(
    { pngBase64: PNG, widthPx: 64, heightPx: 64 },
    { maxWidthCells: 24, maxHeightCells: 6, fallback: '[image]' },
  )
  const lines = component.render(100)
  graphics.terminal.write(lines.join('\n'))
  const first = apcs(terminal.text)
  const upload = first.filter((entry) => entry!.controls.a === 't')
  const placement = first.filter((entry) => entry!.controls.a === 'p')
  assert.equal(upload.length, 1, 'one managed upload')
  assert.equal(placement.length, 1, 'one managed placement')
  assert.ok(terminal.text.indexOf('a=t,f=100') < terminal.text.indexOf('a=p,'), 'a=t precedes a=p')
  assert.equal(upload[0]!.controls.q, '2')
  assert.equal(placement[0]!.controls.q, '2')
  assert.equal(placement[0]!.controls.C, '1')
  assert.equal(placement[0]!.controls.i, upload[0]!.controls.i, 'the placement names the uploaded id')

  terminal.writes.length = 0
  graphics.terminal.write(lines.join('\n'))
  const second = apcs(terminal.text)
  assert.equal(second.filter((entry) => entry!.controls.a === 't').length, 0, 'steady frame never re-uploads')
  assert.equal(second.filter((entry) => entry!.controls.a === 'p').length, 1, 'the same placement is re-offered')
  assert.equal(second[0]!.controls.i, upload[0]!.controls.i, 'same image id')
  graphics.dispose()
})

test('a synchronous probe reply is handled after probing and timer installation', async () => {
  class SyncReplyTerminal extends RecordingTerminal {
    override write(data: string): void {
      super.write(data)
      if (data.includes('a=q,')) this.sendInput(`\x1b_Gi=${/a=q,i=(\d+)/.exec(data)?.[1]};OK\x1b\\`)
    }
  }
  const terminal = new SyncReplyTerminal()
  let allowed = 0
  const graphics = createZellijKittyGraphics(terminal, {}, zellijEnvironment(), () => { allowed += 1 })
  assert.ok(graphics)
  graphics.terminal.start(() => {}, () => {})
  assert.equal(graphics.canPaint(), true, 'the synchronous answer promotes without being overwritten to probing')
  await Promise.resolve()
  assert.equal(allowed, 1, 'the async render notification still fires once')
  graphics.dispose()
})

test('a stop between the live OK and the queued notification drops only that notification', async () => {
  const { graphics, terminal, allowed } = admittedFactory()
  graphics.terminal.start(() => {}, () => {})
  terminal.sendInput(probeReply(terminal))
  graphics.terminal.stop()
  await Promise.resolve()
  assert.equal(graphics.canPaint(), true, 'the one-way admission survives a normal screen stop')
  assert.equal(allowed(), 0, 'the queued notification is dropped while the screen is stopped')

  graphics.terminal.start(() => {}, () => {})
  assert.equal(graphics.canPaint(), true, 'restart keeps the SAME allowed admission')
  assert.equal((terminal.text.match(/a=q,/g) ?? []).length, 1, 'restart never re-sends the query')
  assert.equal(allowed(), 0, 'no stale notification is replayed after restart')
  graphics.dispose()
})

test('a late OK from a previous graphics handle never promotes a new probing handle', async () => {
  const terminal = new RecordingTerminal()
  const first = createZellijKittyGraphics(terminal, {}, zellijEnvironment(), () => {})
  assert.ok(first)
  first.terminal.start(() => {}, () => {})
  const firstProbeId = probeIdOf(terminal)
  first.dispose()

  const second = createZellijKittyGraphics(terminal, {}, zellijEnvironment(), () => {})
  assert.ok(second)
  second.terminal.start(() => {}, () => {})
  const secondProbeId = probeIdOf(terminal)
  assert.notEqual(firstProbeId, secondProbeId, 'each handle gets an independent probe id')
  terminal.sendInput(`\x1b_Gi=${firstProbeId};ENOTSUPPORTED:disabled\x1b\\`)
  await Promise.resolve()
  assert.equal(second.canPaint(), false, 'the previous handle’s late ERROR must not reject the new handle')
  terminal.sendInput(`\x1b_Gi=${firstProbeId};OK\x1b\\`)
  await Promise.resolve()
  assert.equal(second.canPaint(), false, 'the previous handle’s late reply must not promote the new handle')
  terminal.sendInput(`\x1b_Gi=${secondProbeId};OK\x1b\\`)
  await Promise.resolve()
  assert.equal(second.canPaint(), true, 'the new handle’s own reply promotes')
  second.dispose()
})

test('a throwing probe write denies immediately and preserves the real failure', () => {
  const terminal = new RecordingTerminal()
  terminal.failWhen = (data) => data.includes('a=q,')
  const graphics = createZellijKittyGraphics(terminal, {}, zellijEnvironment(), () => {})
  assert.ok(graphics)
  assert.throws(() => graphics.terminal.start(() => {}, () => {}), /terminal write failed/)
  assert.equal(graphics.canPaint(), false, 'a failed query never admits')
  const writes = terminal.writes.length
  graphics.terminal.start(() => {}, () => {})
  assert.equal(terminal.writes.length, writes, 'a denied admission never retries the query')
  graphics.dispose()
})

test('an unanswered probe is denied at the bounded window and a late OK never promotes', async () => {
  const { graphics, terminal, allowed } = admittedFactory()
  graphics.terminal.start(() => {}, () => {})
  assert.equal(graphics.canPaint(), false)
  // The contract IS this bounded window: the probe may only wait 500 ms.
  await new Promise((resolve) => setTimeout(resolve, ZELLIJ_PROBE_TIMEOUT_MS + 60))
  terminal.sendInput(probeReply(terminal))
  await Promise.resolve()
  assert.equal(graphics.canPaint(), false, 'the timeout permanent denial is never undone')
  assert.equal(allowed(), 0, 'a late reply never notifies the product')
  graphics.dispose()
})

test('ENOTSUPPORTED and non-OK replies leave a permanent text fallback', async () => {
  for (const payload of ['ENOTSUPPORTED:disabled', 'EINVAL:bad']) {
    const { graphics, terminal, allowed } = admittedFactory()
    graphics.terminal.start(() => {}, () => {})
    terminal.sendInput(probeReply(terminal, payload))
    await Promise.resolve()
    assert.equal(graphics.canPaint(), false, payload)
    terminal.sendInput(probeReply(terminal))
    await Promise.resolve()
    assert.equal(graphics.canPaint(), false, 'denied is one-way')
    assert.equal(allowed(), 0)
    graphics.dispose()
  }
})

test('stop/start never sends a second query and dispose before the reply never promotes', async () => {
  const { graphics, terminal, allowed } = admittedFactory()
  graphics.terminal.start(() => {}, () => {})
  assert.equal((terminal.text.match(/a=q,/g) ?? []).length, 1)
  graphics.terminal.stop()
  graphics.terminal.start(() => {}, () => {})
  assert.equal((terminal.text.match(/a=q,/g) ?? []).length, 1, 'main/alt screen handoff reuses the one admission')

  graphics.dispose()
  graphics.dispose()
  terminal.sendInput(probeReply(terminal))
  await Promise.resolve()
  assert.equal(graphics.canPaint(), false, 'a disposed admission never promotes')
  assert.equal(allowed(), 0, 'no callback after dispose')
})

test('StdinBuffer rebuilds the split probe reply into one complete consumed sequence', () => {
  const { graphics, terminal, allowed } = admittedFactory()
  const input: string[] = []
  graphics.terminal.start((data) => input.push(data), () => {})
  const buffer = new StdinBuffer()
  buffer.on('data', (sequence) => terminal.sendInput(sequence))
  const probeId = probeIdOf(terminal)
  for (const chunk of ['\x1b', '_G', 'i=', probeId, ';OK', '\x1b\\']) {
    buffer.process(chunk)
  }
  assert.equal(graphics.canPaint(), true, 'the real stdin framing completes the reply')
  assert.deepEqual(input, [], 'the complete reply is consumed before the screen')
  buffer.process('a')
  assert.deepEqual(input, ['a'], 'ordinary input still reaches the editor')
  buffer.destroy()
  assert.equal(allowed(), 0, 'the callback is queued, not synchronous')
  graphics.dispose()
})

// ── Image-8 / I8-5: one Zellij negotiated handle (ZA01–ZA12) ───────────────

/** The frozen Zellij pane environment; host hints never grant SIXEL. */
function zellijSixelEnvironment(
  cli: FakeZellijCli,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...cli.env,
    TERM: 'xterm-256color',
    TERM_PROGRAM: 'ghostty',
    ZELLIJ: '0',
    ZELLIJ_SESSION_NAME: 'zellij-sixel-unit',
    PI_TUI_TMUX_KITTY_IMAGES: '0',
  }
  delete environment.TMUX
  delete environment.STY
  delete environment.PI_IMAGE_PROTOCOL
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key]
    else environment[key] = value
  }
  return environment
}

interface NegotiatedHarness {
  readonly graphics: ZellijNegotiatedGraphics
  readonly terminal: RecordingTerminal
  readonly kittySelected: () => number
  readonly sixelSettled: () => number
}

function negotiatedFactory(
  t: test.TestContext,
  cli: FakeZellijCli,
  overrides: Record<string, string | undefined> = {},
): NegotiatedHarness {
  const terminal = new RecordingTerminal()
  let kittySelected = 0
  let sixelSettled = 0
  const graphics = createZellijNegotiatedGraphics(
    terminal,
    zellijSixelEnvironment(cli, overrides),
    () => { kittySelected += 1 },
    () => { sixelSettled += 1 },
  )
  assert.ok(graphics, 'the Zellij pane must produce one negotiated handle')
  t.after(() => graphics.dispose())
  return { graphics, terminal, kittySelected: () => kittySelected, sixelSettled: () => sixelSettled }
}

async function until(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The active Screen's real observation face: cell reply + OSC 11 background. */
class ZellijScriptedScreen implements SixelScreenObservation {
  cellQueries = 0
  private readonly listeners = new Set<(cell: { widthPx: number; heightPx: number }) => void>()

  queryCellSizeForSixel(): void {
    this.cellQueries += 1
    setImmediate(() => this.replyCell(10, 20))
  }

  onCellSizeObserved(listener: (cell: { widthPx: number; heightPx: number }) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async queryTerminalBackgroundColor(): Promise<{ r: number; g: number; b: number } | undefined> {
    return { r: 0x28, g: 0x2c, b: 0x34 }
  }

  replyCell(widthPx: number, heightPx: number): void {
    for (const listener of [...this.listeners]) listener({ widthPx, heightPx })
  }
}

/** Drive the three real Screen port calls until the encode settles. */
async function paintZellijRaster(
  graphics: ZellijNegotiatedGraphics,
  screen: object,
  image: PixelBody,
  width: number,
): Promise<string> {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const lines = image.render(width)
    const token = lines[0] ?? ''
    const info = graphics.sixelScreen.candidate(token)
    if (info === undefined) throw new Error('the negotiated image did not emit a candidate')
    graphics.sixelScreen.reconcileVisible(screen, [{ line: token, cropTopRows: 0, visibleRows: info.layoutRows, physicalRow: 0 }])
    const dcs = graphics.sixelScreen.materialize(token, 0, info.layoutRows)
    if (dcs !== undefined) {
      const footprint = graphics.sixelScreen.footprint(dcs)
      graphics.sixelScreen.framePainted(screen, [{
        line: token,
        dcs,
        cropTopRows: 0,
        visibleRows: footprint?.rows ?? info.layoutRows,
        emitted: true,
      }])
      return dcs
    }
    graphics.sixelScreen.framePainted(screen, [])
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for the Zellij SIXEL raster')
}

test('ZA01: a matching Kitty OK first locks kitty even when DA1 attr4 arrives later', (t) => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const h = negotiatedFactory(t, createFakeZellijCli(t))
  h.graphics.terminal.start(() => {}, () => {})
  h.terminal.sendInput(probeReply(h.terminal))
  h.terminal.declareSixel(true)
  assert.equal(h.graphics.selectedProtocol(), 'kitty')
  assert.equal(h.graphics.canPaint(), true)
  assert.equal(effectiveImageProtocol(h.graphics), 'kitty')
  assert.equal(h.sixelSettled(), 0, 'SIXEL is never selected after a Kitty positive')
  const body = h.graphics.image(
    { pngBase64: PNG, widthPx: 64, heightPx: 64 },
    { maxWidthCells: 20, maxHeightCells: 6, fallback: '[fallback]' },
  )
  assert.ok(body.render(80)[0]!.startsWith('\x1b_G'), 'the single Kitty delegate paints the managed APC')
  assert.equal(h.terminal.text.includes('\x1bP0;1;q'), false, 'zero SIXEL DCS')
})

test('ZA02: DA1 attr4 first cannot outrun a later Kitty OK inside 500 ms', (t) => {
  const h = negotiatedFactory(t, createFakeZellijCli(t))
  h.graphics.terminal.start(() => {}, () => {})
  h.terminal.declareSixel(true)
  h.terminal.sendInput(probeReply(h.terminal))
  assert.equal(h.graphics.selectedProtocol(), 'kitty', 'Kitty priority is order-independent')
  assert.equal(effectiveImageProtocol(h.graphics), 'kitty')
  h.terminal.declareSixel(false)
  assert.equal(h.graphics.selectedProtocol(), 'kitty', 'a later DA1 never changes a locked protocol')
  assert.equal(h.terminal.text.includes('\x1bP0;1;q'), false)
})

test('ZA03: Kitty denied + DA1 attr4 + eligible version selects SIXEL, text until the owner has facts', async (t) => {
  const h = negotiatedFactory(t, createFakeZellijCli(t))
  h.graphics.terminal.start(() => {}, () => {})
  h.terminal.declareSixel(true)
  h.terminal.sendInput(probeReply(h.terminal, 'ENOTSUPPORTED:disabled'))
  assert.equal(h.graphics.selectedProtocol(), 'sixel')
  assert.equal(h.graphics.canPaint(), false, 'the owner has no screen facts yet')
  assert.equal(effectiveImageProtocol(h.graphics), null)
  const image = h.graphics.image(
    { pngBase64: PNG, widthPx: 64, heightPx: 64 },
    { maxWidthCells: 20, maxHeightCells: 6, fallback: '[fallback]' },
  )
  assert.deepEqual(image.render(80), ['[fallback]'], 'pending owner readiness paints text')
  assert.equal(h.terminal.text.includes('\x1bP0;1;q'), false)

  const screen = new ZellijScriptedScreen()
  h.graphics.observeScreen(screen, 80, 24)
  await until(() => h.graphics.canPaint(), 'the SIXEL owner geometry/background facts')
  assert.equal(effectiveImageProtocol(h.graphics), 'sixel')
  assert.ok(h.sixelSettled() >= 1, 'the product SIXEL settle seam was notified')
})

test('ZA04: Kitty denied + DA1 without attr4 locks text and rejects inherited host hints', (t) => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const h = negotiatedFactory(t, createFakeZellijCli(t), { TERM_PROGRAM: 'ghostty', GHOSTTY_RESOURCES_DIR: '/ghostty' })
  h.graphics.terminal.start(() => {}, () => {})
  h.terminal.declareSixel(false)
  h.terminal.sendInput(probeReply(h.terminal, 'ENOTSUPPORTED:disabled'))
  assert.equal(h.graphics.selectedProtocol(), null)
  assert.equal(h.graphics.canPaint(), false)
  assert.equal(effectiveImageProtocol(h.graphics), null, 'no inherited ghostty/kitty fallback')
  assert.equal(h.terminal.text.includes('a=t,f=100'), false, 'no Kitty image payload')
  assert.equal(h.terminal.text.includes('a=p,'), false, 'no Kitty placement')
  assert.equal(h.terminal.text.includes('\x1bP0;1;q'), false)
})

test('ZA05: no DA1 within 800 ms locks text permanently; a late true never upgrades', async (t) => {
  const h = negotiatedFactory(t, createFakeZellijCli(t))
  h.graphics.terminal.start(() => {}, () => {})
  h.terminal.sendInput(probeReply(h.terminal, 'ENOTSUPPORTED:disabled'))
  // reason: the contract IS the 800 ms initial DA1 bound.
  await new Promise(resolve => setTimeout(resolve, ZELLIJ_SIXEL_DA1_TIMEOUT_MS + 60))
  assert.equal(h.graphics.selectedProtocol(), null)
  h.terminal.declareSixel(true)
  assert.equal(h.graphics.selectedProtocol(), null, 'a late DA1 cannot reopen a settled negotiation')
  assert.equal(h.graphics.canPaint(), false)
})

test('ZA06: ineligible, missing, malformed or timed-out Zellij versions never select SIXEL', async (t) => {
  const cases: ReadonlyArray<{ name: string; version?: string; delayMs?: number; path?: string }> = [
    { name: '0.44.9', version: 'zellij 0.44.9\n' },
    { name: 'malformed', version: 'zellij 0.45.x\n' },
    { name: 'missing binary', path: '/nonexistent-dsh-image8-version' },
    { name: 'timeout', delayMs: 1_200 },
  ]
  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const cli = createFakeZellijCli(st)
      if (entry.version !== undefined) cli.setReply({ text: entry.version })
      if (entry.delayMs !== undefined) cli.setReply({ text: 'zellij 0.45.1\n', delayMs: entry.delayMs })
      const h = negotiatedFactory(st, cli, entry.path === undefined ? {} : { PATH: entry.path })
      h.graphics.terminal.start(() => {}, () => {})
      h.terminal.declareSixel(true)
      h.terminal.sendInput(probeReply(h.terminal, 'ENOTSUPPORTED:disabled'))
      assert.equal(h.graphics.selectedProtocol(), null, `${entry.name}: SIXEL must not be selected`)
      assert.equal(h.graphics.canPaint(), false)
    })
  }

  // A Kitty positive is still allowed on an old Zellij version.
  const cli = createFakeZellijCli(t, 'zellij 0.44.9\n')
  const h = negotiatedFactory(t, cli)
  h.graphics.terminal.start(() => {}, () => {})
  h.terminal.declareSixel(true)
  h.terminal.sendInput(probeReply(h.terminal))
  assert.equal(h.graphics.selectedProtocol(), 'kitty', 'the version gate only excludes SIXEL')
})

test('zellijVersionEligible strictly parses the local program version', (t) => {
  const good = createFakeZellijCli(t, 'zellij 0.45.0\n')
  assert.equal(zellijVersionEligible(zellijSixelEnvironment(good)), true)
  assert.deepEqual(good.calls(), ['--version'])
  const newer = createFakeZellijCli(t, 'zellij 1.2.3\n')
  assert.equal(zellijVersionEligible(zellijSixelEnvironment(newer)), true)
  const old = createFakeZellijCli(t, 'zellij 0.44.9\n')
  assert.equal(zellijVersionEligible(zellijSixelEnvironment(old)), false)
  const fake = createFakeZellijCli(t, 'acme 0.45.1\n')
  assert.equal(zellijVersionEligible(zellijSixelEnvironment(fake)), false)
  assert.equal(zellijVersionEligible({ ...zellijSixelEnvironment(fake), PATH: '/nonexistent-dsh-image8-version' }), false)
})


test('ZA06b: a synchronous Kitty rejection during start still sees the version gate once it arrives', async (t) => {
  class SyncRejectTerminal extends RecordingTerminal {
    override write(data: string): void {
      super.write(data)
      if (data.includes('a=q,')) {
        const id = /a=q,i=(\d+)/.exec(data)?.[1]
        this.sendInput(`\x1b_Gi=${id};ENOTSUPPORTED:disabled\x1b\\`)
      }
    }
  }
  const cli = createFakeZellijCli(t)
  const terminal = new SyncRejectTerminal()
  terminal.declareSixel(true)
  let sixel = 0
  const graphics = createZellijNegotiatedGraphics(
    terminal,
    zellijSixelEnvironment(cli),
    () => {},
    () => { sixel += 1 },
  )
  assert.ok(graphics)
  graphics.terminal.start(() => {}, () => {})
  assert.equal(graphics.selectedProtocol(), 'sixel', 'the synchronous denial waits for the version gate')
  await Promise.resolve()
  assert.ok(sixel >= 1)
  graphics.dispose()
})

test('ZA07: topology and explicit-protocol gates stay exactly as before', (t) => {
  const cli = createFakeZellijCli(t)
  const base = zellijSixelEnvironment(cli)
  const gates: ReadonlyArray<readonly [string, NodeJS.ProcessEnv]> = [
    ['ZELLIJ missing', { ...base, ZELLIJ: undefined }],
    ['ZELLIJ empty', { ...base, ZELLIJ: '' }],
    ['PI_IMAGE_PROTOCOL=none', { ...base, PI_IMAGE_PROTOCOL: 'none' }],
    ['PI_IMAGE_PROTOCOL=0', { ...base, PI_IMAGE_PROTOCOL: '0' }],
    ['PI_IMAGE_PROTOCOL=iterm2', { ...base, PI_IMAGE_PROTOCOL: 'iterm2' }],
    ['nested TMUX', { ...base, TMUX: '/tmp/tmux,1,0' }],
    ['nested STY', { ...base, STY: 'screen-1' }],
  ]
  for (const [name, environment] of gates) {
    assert.equal(
      createZellijNegotiatedGraphics(new RecordingTerminal(), environment, () => {}, () => {}),
      undefined,
      `${name}: no handle`,
    )
  }

  // PI_IMAGE_PROTOCOL=kitty still requires a real Kitty OK and forbids SIXEL.
  const explicitKitty = negotiatedFactory(t, cli, { PI_IMAGE_PROTOCOL: 'kitty' })
  explicitKitty.graphics.terminal.start(() => {}, () => {})
  explicitKitty.terminal.declareSixel(true)
  explicitKitty.terminal.sendInput(probeReply(explicitKitty.terminal, 'ENOTSUPPORTED:disabled'))
  assert.equal(explicitKitty.graphics.selectedProtocol(), null, 'an explicit kitty never falls into SIXEL')

  // PI_IMAGE_PROTOCOL=sixel is not a manual grant: the real DA1 is still required.
  const explicitSixel = negotiatedFactory(t, cli, { PI_IMAGE_PROTOCOL: 'sixel' })
  explicitSixel.graphics.terminal.start(() => {}, () => {})
  explicitSixel.terminal.sendInput(probeReply(explicitSixel.terminal, 'ENOTSUPPORTED:disabled'))
  explicitSixel.terminal.declareSixel(false)
  assert.equal(explicitSixel.graphics.selectedProtocol(), null, 'no DA1 attr4 means text')
  const automaticSixel = negotiatedFactory(t, cli, { PI_IMAGE_PROTOCOL: 'sixel' })
  automaticSixel.graphics.terminal.start(() => {}, () => {})
  automaticSixel.terminal.declareSixel(true)
  automaticSixel.terminal.sendInput(probeReply(automaticSixel.terminal, 'ENOTSUPPORTED:disabled'))
  assert.equal(automaticSixel.graphics.selectedProtocol(), 'sixel', 'the existing auto semantics still apply')
})

test('ZA08: after Kitty is locked, every late DA1 and duplicate probe reply is inert', (t) => {
  const h = negotiatedFactory(t, createFakeZellijCli(t))
  h.graphics.terminal.start(() => {}, () => {})
  h.terminal.sendInput(probeReply(h.terminal))
  h.terminal.declareSixel(false)
  h.terminal.declareSixel(true)
  h.terminal.sendInput(probeReply(h.terminal))
  assert.equal(h.graphics.selectedProtocol(), 'kitty')
  assert.equal(h.graphics.canPaint(), true)
  assert.equal(h.terminal.text.includes('\x1bP0;1;q'), false)
})

test('ZA09: a later complete DA1 false permanently revokes a selected SIXEL surface', async (t) => {
  const h = negotiatedFactory(t, createFakeZellijCli(t))
  h.graphics.terminal.start(() => {}, () => {})
  h.terminal.declareSixel(true)
  h.terminal.sendInput(probeReply(h.terminal, 'ENOTSUPPORTED:disabled'))
  const screen = new ZellijScriptedScreen()
  h.graphics.observeScreen(screen, 80, 24)
  await until(() => h.graphics.canPaint(), 'the SIXEL owner facts')
  const image = h.graphics.image(
    { pngBase64: PNG, widthPx: 64, heightPx: 64 },
    { maxWidthCells: 20, maxHeightCells: 6, fallback: '[fallback]' },
  )
  const dcs = await paintZellijRaster(h.graphics, screen, image, 80)
  assert.notEqual(h.graphics.sixelScreen.footprint(dcs), undefined, 'the raster is trusted before revocation')

  h.terminal.declareSixel(false)
  await until(() => h.graphics.selectedProtocol() === null, 'the one-way revoke')
  assert.equal(h.graphics.canPaint(), false)
  assert.equal(effectiveImageProtocol(h.graphics), null)
  assert.equal(h.graphics.sixelScreen.footprint(dcs), undefined, 'the registry dropped the old paint fact')
  assert.equal(image.paintedBodyAt?.(80), undefined, 'no ghost click body survives')
  h.terminal.declareSixel(true)
  assert.equal(h.graphics.selectedProtocol(), null, 'a later true never restores SIXEL')
})


test('ZA09b: a real Screen stop -> start re-verifies an already selected SIXEL pane once', async (t) => {
  const h = negotiatedFactory(t, createFakeZellijCli(t))
  h.graphics.terminal.start(() => {}, () => {})
  h.terminal.declareSixel(true)
  h.terminal.sendInput(probeReply(h.terminal, 'ENOTSUPPORTED:disabled'))
  const screen = new ZellijScriptedScreen()
  h.graphics.observeScreen(screen, 80, 24)
  await until(() => h.graphics.canPaint(), 'the SIXEL owner facts')
  const before = (h.terminal.text.match(/\x1b\[c/g) ?? []).length
  h.graphics.terminal.stop()
  h.graphics.terminal.start(() => {}, () => {})
  assert.equal((h.terminal.text.match(/\x1b\[c/g) ?? []).length, before + 1,
    'the restarted Screen sends one bounded re-query')
  assert.equal(h.graphics.selectedProtocol(), 'sixel', 'the protocol remains SIXEL while re-verifying')
})


test('ZA09c: a negative re-query reply is consumed before the editor and revokes SIXEL', async (t) => {
  const h = negotiatedFactory(t, createFakeZellijCli(t))
  const input: string[] = []
  h.graphics.terminal.start(data => input.push(data), () => {})
  h.terminal.declareSixel(true)
  h.terminal.sendInput(probeReply(h.terminal, 'ENOTSUPPORTED:disabled'))
  const screen = new ZellijScriptedScreen()
  h.graphics.observeScreen(screen, 80, 24)
  await until(() => h.graphics.canPaint(), 'the SIXEL owner facts')
  input.length = 0
  h.graphics.resample()
  h.terminal.declareSixel(false)
  await until(() => h.graphics.selectedProtocol() === null, 'the negative re-query revoke')
  assert.deepEqual(input, [], 'the re-query DA1 reply never reaches the editor')
})

test('ZA10: dispose during the timers/write path leaves no late promotion or render callback', async (t) => {
  const cli = createFakeZellijCli(t)
  const h = negotiatedFactory(t, cli)
  h.graphics.terminal.start(() => {}, () => {})
  h.graphics.dispose()
  h.terminal.declareSixel(true)
  h.terminal.sendInput(probeReply(h.terminal))
  // reason: both the 500 ms Kitty and 800 ms DA1 deadlines must be observed dead.
  await new Promise(resolve => setTimeout(resolve, ZELLIJ_SIXEL_DA1_TIMEOUT_MS + 60))
  assert.equal(h.kittySelected(), 0)
  assert.equal(h.sixelSettled(), 0)
  assert.equal(h.graphics.selectedProtocol(), null)
  assert.equal(h.terminal.text.includes('\x1bP0;1;q'), false)
})

test('ZA11: thirty text renders run the version gate once and never re-probe', async (t) => {
  const cli = createFakeZellijCli(t)
  const h = negotiatedFactory(t, cli)
  h.graphics.terminal.start(() => {}, () => {})
  const callsAfterStart = cli.calls().length
  assert.equal(callsAfterStart, 1, 'one local version read at candidate start')
  for (let index = 0; index < 30; index += 1) {
    const image = h.graphics.image(
      { pngBase64: PNG, widthPx: 64, heightPx: 64 },
      { maxWidthCells: 20, maxHeightCells: 6, fallback: '[fallback]' },
    )
    assert.deepEqual(image.render(80), ['[fallback]'])
  }
  assert.equal(cli.calls().length, callsAfterStart, 'no per-frame subprocess')
  assert.equal((h.terminal.text.match(/a=q,/g) ?? []).length, 1, 'one initial Kitty probe')
})

test('ZA12: the old Kitty factory and Direct SIXEL gates keep their exact behavior', (t) => {
  const cli = createFakeZellijCli(t)
  const environment = zellijSixelEnvironment(cli)
  const old = createZellijKittyGraphics(new RecordingTerminal(), {}, environment, () => {})
  assert.ok(old)
  assert.equal(old.mode, 'native', 'the old factory remains a native Kitty handle')
  const negotiated = createZellijNegotiatedGraphics(new RecordingTerminal(), environment, () => {}, () => {})
  assert.ok(negotiated)
  assert.equal(negotiated.mode, 'zellij-negotiated')
  assert.equal(createDirectSixelGraphics(new RecordingTerminal(), environment), undefined,
    'a Zellij pane never gets a Direct SIXEL factory')
})
