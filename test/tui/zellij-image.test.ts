/**
 * Image-7C-3 — Ghostty-host Zellij admission, probe input and Native writer.
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
  candidateGhosttyZellij,
  createZellijKittyGraphics,
  zellijProbeWire,
} from '../../src/tui/graphics/zellij-image.ts'
import { parseKittyApc } from '../../src/tui/graphics/kitty-native.ts'
import type { KittyGraphics } from '../../src/tui/graphics/native-image.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function probeIdOf(terminal: RecordingTerminal): string {
  const matches = [...terminal.text.matchAll(/a=q,i=(\d+)/g)]
  assert.ok(matches.length > 0, 'the facade sent a probe query')
  return matches.at(-1)![1]!
}

function probeReply(terminal: RecordingTerminal, payload = 'OK'): string {
  return `\x1b_Gi=${probeIdOf(terminal)};${payload}\x1b\\`
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

  get text(): string {
    return this.writes.join('')
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

/** The real Ghostty-host Zellij pane environment (one explicit sandbox object). */
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

test('the fixed candidate matrix admits only Ghostty-host Zellij panes and never queries early', () => {
  for (const term of ['xterm-ghostty', 'xterm-256color', 'custom-term', undefined]) {
    const environment = zellijEnvironment({ TERM: term })
    assert.equal(candidateGhosttyZellij(environment), true, `TERM=${term ?? 'unset'} is not an identity fact`)
    const terminal = new RecordingTerminal()
    const graphics = createZellijKittyGraphics(terminal, {}, environment, () => {})
    assert.ok(graphics, `TERM=${term ?? 'unset'} creates the candidate factory`)
    assert.equal(terminal.writes.length, 0, 'the factory never writes before the real input listener starts')
    graphics.dispose()
  }
})

test('every non-candidate environment creates no handle and runs no query or image work', () => {
  const cases: ReadonlyArray<{ name: string; environment: NodeJS.ProcessEnv; capability?: 'kitty' | 'iterm2' | null }> = [
    { name: 'ZELLIJ unset', environment: zellijEnvironment({ ZELLIJ: undefined }) },
    { name: 'ZELLIJ=1', environment: zellijEnvironment({ ZELLIJ: '1' }) },
    { name: 'ZELLIJ empty', environment: zellijEnvironment({ ZELLIJ: '' }) },
    { name: 'session missing', environment: zellijEnvironment({ ZELLIJ_SESSION_NAME: undefined }) },
    { name: 'session empty', environment: zellijEnvironment({ ZELLIJ_SESSION_NAME: '' }) },
    { name: 'TERM_PROGRAM missing', environment: zellijEnvironment({ TERM_PROGRAM: undefined }) },
    { name: 'TERM_PROGRAM=wezterm', environment: zellijEnvironment({ TERM_PROGRAM: 'wezterm' }) },
    { name: 'TERM_PROGRAM=herdr', environment: zellijEnvironment({ TERM_PROGRAM: 'herdr' }) },
    { name: 'lone GHOSTTY_RESOURCES_DIR', environment: zellijEnvironment({ TERM_PROGRAM: undefined, GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty' }) },
    { name: 'WEZTERM_PANE inherited', environment: zellijEnvironment({ WEZTERM_PANE: '7' }) },
    { name: 'WARP_SESSION_ID inherited', environment: zellijEnvironment({ WARP_SESSION_ID: 'warp-1' }) },
    { name: 'WARP_TERMINAL_SESSION_UUID inherited', environment: zellijEnvironment({ WARP_TERMINAL_SESSION_UUID: 'warp-uuid' }) },
    { name: 'TMUX nested', environment: zellijEnvironment({ TMUX: '/tmp/tmux,1,0' }) },
    { name: 'STY nested', environment: zellijEnvironment({ STY: 'screen-1' }) },
    { name: 'TERM=tmux-256color', environment: zellijEnvironment({ TERM: 'tmux-256color' }) },
    { name: 'TERM=screen-256color', environment: zellijEnvironment({ TERM: 'screen-256color' }) },
    { name: 'fork images=null', environment: zellijEnvironment(), capability: null },
    { name: 'fork images=iterm2', environment: zellijEnvironment(), capability: 'iterm2' },
    { name: 'PI_IMAGE_PROTOCOL=none', environment: zellijEnvironment({ PI_IMAGE_PROTOCOL: 'none' }) },
    { name: 'PI_IMAGE_PROTOCOL=0', environment: zellijEnvironment({ PI_IMAGE_PROTOCOL: '0' }) },
    { name: 'PI_IMAGE_PROTOCOL=iterm2', environment: zellijEnvironment({ PI_IMAGE_PROTOCOL: 'iterm2' }) },
    {
      name: 'PI_IMAGE_PROTOCOL=kitty on a WezTerm host',
      environment: zellijEnvironment({ TERM_PROGRAM: 'wezterm', PI_IMAGE_PROTOCOL: 'kitty' }),
    },
  ]
  for (const entry of cases) {
    if (entry.capability !== undefined) {
      resetCapabilitiesCache()
      setCapabilities({ images: entry.capability, trueColor: true, hyperlinks: false })
    }
    const terminal = new RecordingTerminal()
    assert.equal(candidateGhosttyZellij(entry.environment), false, entry.name)
    assert.equal(
      createZellijKittyGraphics(terminal, {}, entry.environment, () => {}),
      undefined,
      `${entry.name}: no Core/facade/handle`,
    )
    assert.equal(terminal.writes.length, 0, `${entry.name}: no probe write`)
    resetCapabilitiesCache()
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
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
