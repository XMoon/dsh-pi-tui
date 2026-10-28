/**
 * Image-7A PR1 — the graphics owner and its terminal gate.
 *
 * These are the permission tests: only the Core may free its own image data,
 * a legacy writer's deletion intent becomes a scoped placement removal, a
 * foreign owner is never touched, and every re-transmission happens after the
 * clear that invalidated the data and before the placement that needs it.
 * @module @xmoon76/dsh-pi-tui/tui/kitty-graphics-owner.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getCapabilities,
  resetCapabilitiesCache,
  setCapabilities,
  setCapabilityOverrides,
  type Terminal,
  type TerminalProgressState,
} from '@xmoon76/pi-tui'
import {
  KittyGraphicsCore,
  MAX_RESIDENT_DECODED_BYTES,
  MAX_RESIDENT_PAYLOAD_BYTES,
  type KittyGraphicsEvent,
} from '../../src/tui/graphics/kitty-core.ts'
import {
  encodeKittyDeleteImage,
  encodeKittyDeletePlacement,
  encodeKittyPlacement,
  parseKittyApc,
} from '../../src/tui/graphics/kitty-native.ts'
import { KittyTerminalFacade } from '../../src/tui/graphics/kitty-terminal.ts'
import { KITTY_VIRTUAL_PLACEHOLDER } from '../../src/tui/graphics/tmux-virtual.ts'
import { NativeKittyImage, admitsNativeKitty, createNativeKittyGraphics } from '../../src/tui/graphics/native-image.ts'
import { createTmuxKittyGraphics, TmuxKittyImage } from '../../src/tui/graphics/tmux-image.ts'
import { createFakeTmuxCli } from '../support/fake-tmux-cli.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

class RecordingTerminal implements Terminal {
  readonly writes: string[] = []
  /** When set, the matching write throws after the bytes were recorded. */
  failWhen: ((data: string) => boolean) | undefined
  columns = 80
  rows = 24
  kittyProtocolActive = true

  get text(): string {
    return this.writes.join('')
  }

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    // Record BEFORE the throw: a real tty may have accepted a prefix (or all)
    // of the bytes by the time the write surfaces an error.
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

function harness(options: { onEvent?: (event: KittyGraphicsEvent) => void } = {}) {
  const terminal = new RecordingTerminal()
  const core = new KittyGraphicsCore(options)
  const facade = new KittyTerminalFacade(terminal, core)
  return { terminal, core, facade }
}

function source(payload = PNG, widthPx = 64, heightPx = 64) {
  return { pngBase64: payload, widthPx, heightPx }
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

/** The environment keys the real capability detection reads for this gate. */
const CAPABILITY_ENV_KEYS = [
  'TERM',
  'TERM_PROGRAM',
  'KITTY_WINDOW_ID',
  'GHOSTTY_RESOURCES_DIR',
  'TMUX',
  'ZELLIJ',
  'STY',
  'PI_IMAGE_PROTOCOL',
] as const

/**
 * Run `probe` under EXACTLY `environment` through the fork's real capability
 * detection: every key above is cleared first, the capability cache and
 * overrides are reset, and both the environment and the cache are restored
 * afterwards. Unlike `setCapabilities`, this proves the source-of-truth path
 * an actual process would take.
 */
function withDetectedEnvironment(environment: Record<string, string | undefined>, probe: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const key of CAPABILITY_ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[key] = value
  }
  setCapabilityOverrides({})
  resetCapabilitiesCache()
  try {
    probe()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    setCapabilityOverrides({})
    resetCapabilitiesCache()
  }
}

test('a placement transmits once, then only re-places', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const lines = component.render(80)
  facade.write(lines.join('\r\n'))
  const first = terminal.text
  assert.equal(count(first, 'a=t,f=100'), 1, 'the payload is transmitted')
  assert.equal(count(first, 'a=p,'), 1, 'one placement for the occurrence')
  assert.ok(first.indexOf('a=t,f=100') < first.indexOf('a=p,'), 'the transmission is emitted before the placement')
  assert.equal(count(first, 'q=2'), count(first, 'a=t,f=100') + count(first, 'a=p,'), 'every APC is quiet')

  // A second, unchanged frame re-emits the same anchor line: the screen's own
  // line dedupe may write it, but the data must already be resident.
  terminal.writes.length = 0
  facade.write(lines.join('\r\n'))
  assert.equal(count(terminal.text, 'a=t,f=100'), 0, 'no re-transmission for a resident image')
  assert.equal(count(terminal.text, 'a=p,'), 1, 'the placement is still written')
})

test('a real clear invalidates the data and the next placement re-transmits after it', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  facade.write(anchor)
  assert.equal(count(terminal.text, 'a=t,f=100'), 1)

  terminal.writes.length = 0
  facade.write(`\x1b[2J\x1b[H\x1b[3J${anchor}`)
  const text = terminal.text
  const clearAt = text.indexOf('\x1b[2J')
  const transmitAt = text.indexOf('a=t,f=100')
  const placeAt = text.indexOf('a=p,')
  assert.ok(clearAt !== -1, 'the clear reaches the terminal')
  assert.ok(transmitAt > clearAt, 'the re-transmission happens AFTER the invalidating clear')
  assert.ok(placeAt > transmitAt, 'and BEFORE the placement')
  assert.equal(count(text, 'a=t,f=100'), 1, 'exactly one re-transmission')
})

test('a 3J-only clear is a data-invalidating clear (measured on Kitty 0.41.1)', () => {
  // Stage-0 S0-4 measured a bare `3J` in a fresh state: the visible screen is
  // empty AND the old image data paints nothing until the payload is sent
  // again. The gate must therefore re-transmit after it, exactly like `2J`.
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  facade.write(anchor)
  terminal.writes.length = 0
  facade.write(`\x1b[3J${anchor}`)
  assert.equal(count(terminal.text, 'a=t,f=100'), 1, 'the payload is sent again')
  assert.ok(terminal.text.indexOf('a=t,f=100') > terminal.text.indexOf('\x1b[3J'), 'after the clear')
  assert.ok(terminal.text.indexOf('a=t,f=100') < terminal.text.indexOf('a=p,'), 'and before the placement')
})

test('a legacy per-id delete of a managed image removes the placement, never the data', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  facade.write(anchor)
  const id = component.imageId!

  terminal.writes.length = 0
  facade.write(encodeKittyDeleteImage(id))
  assert.equal(terminal.text, encodeKittyDeletePlacement(id), 'translated to a scoped placement removal')
  assert.ok(!terminal.text.includes('d=I'), 'the writer may not free the data')

  // The image was hidden, not retired: re-showing it re-places the resident data.
  terminal.writes.length = 0
  facade.write(anchor)
  assert.equal(count(terminal.text, 'a=t,f=100'), 0, 'a hidden image keeps its resident data')
  assert.equal(count(terminal.text, 'a=p,'), 1)
})

test('a foreign per-id delete passes through untouched', () => {
  const { terminal, facade } = harness()
  const foreign = encodeKittyDeleteImage(0xabcdef)
  facade.write(foreign)
  assert.equal(terminal.text, foreign)
})

test('global deletes are translated into scoped own-id operations only', () => {
  const { terminal, facade, core } = harness()
  const first = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const second = new NativeKittyImage(core, source('AAAA', 32, 32), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(first.render(80).join('\r\n') + second.render(80).join('\r\n'))
  const ids = [first.imageId!, second.imageId!]

  terminal.writes.length = 0
  facade.write('\x1b_Ga=d,d=a,q=2\x1b\\')
  assert.ok(!terminal.text.includes('d=a'), 'the global placement delete never reaches the terminal')
  for (const id of ids) assert.ok(terminal.text.includes(encodeKittyDeletePlacement(id)), `scoped removal for ${id}`)

  terminal.writes.length = 0
  facade.write('\x1b_Ga=d,d=A,q=2\x1b\\')
  assert.ok(!terminal.text.includes('d=A'), 'the global image delete never reaches the terminal')
  for (const id of ids) assert.ok(terminal.text.includes(encodeKittyDeleteImage(id)), `scoped retire for ${id}`)
})

test('a bare a=d (the protocol default) is also a global delete', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(component.render(80).join('\r\n'))
  const imageId = component.imageId!
  terminal.writes.length = 0
  facade.write('\x1b_Ga=d\x1b\\')
  assert.ok(!terminal.text.includes('a=d\x1b'), 'the bare global form never reaches the terminal')
  assert.ok(terminal.text.includes(encodeKittyDeletePlacement(imageId)), 'it becomes a scoped placement removal')
})

test('a global delete in the alt buffer never touches a main-screen image', () => {
  const { terminal, facade, core } = harness()
  const main = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(main.render(80).join('\r\n'))
  const mainId = main.imageId!

  // Enter the alternate buffer and place a DIFFERENT image there.
  facade.write('\x1b[?1049h')
  const alt = new NativeKittyImage(core, source('AAAA', 32, 32), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(alt.render(80).join('\r\n'))
  const altId = alt.imageId!
  terminal.writes.length = 0

  // The alternate screen's own release at stop is a GLOBAL delete in the alt
  // buffer: it may only release what the alt buffer holds.
  facade.write('\x1b_Ga=d,d=A,q=2\x1b\\')
  const text = terminal.text
  assert.ok(text.includes(`a=d,d=I,i=${altId}`), 'the alt buffer releases its own image')
  assert.ok(!text.includes(`i=${mainId}`), 'the main screen\'s image is never mentioned')

  // Leaving the alternate buffer restores the main screen with its data intact.
  terminal.writes.length = 0
  facade.write('\x1b[?1049l')
  facade.write(main.render(80).join('\r\n'))
  assert.equal(count(terminal.text, 'a=t,f=100'), 0, 'the main image was never re-transmitted')
  assert.equal(count(terminal.text, 'a=p,'), 1, 'it is simply placed again')
})

test('a global image delete only releases data the current buffer holds', () => {
  const { terminal, facade, core } = harness()
  const image = core.register(source())
  const imageId = image!.imageId
  // Transmitted and placed in the MAIN buffer only.
  facade.write(core.transmissionFor(imageId, 'main') + encodeKittyPlacement(imageId, 1, { columns: 4, rows: 2 }))
  terminal.writes.length = 0
  facade.write('\x1b[?1049h')
  terminal.writes.length = 0
  facade.write('\x1b_Ga=d,d=A,q=2\x1b\\')
  assert.ok(!terminal.text.includes('a=d'), 'nothing is released while the alt buffer owns no copy')
})

test('the gate holds a graphics introducer split between ESC and _G', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(component.render(80).join('\r\n'))
  const imageId = component.imageId!

  // `ESC` | `_G...`: the introducer must not reach the terminal unparsed.
  terminal.writes.length = 0
  facade.write('\x1b')
  facade.write('_Ga=d,d=A,q=2\x1b\\')
  assert.ok(terminal.text.includes(`a=d,d=I,i=${imageId}`), 'the split global delete was translated')
  assert.ok(!/\x1b_Ga=d,d=A/.test(terminal.text), 'the global form never reached the terminal')

  // `ESC_` | `G...`: same boundary, one character later.
  const other = new NativeKittyImage(core, source('AAAA', 8, 8), { maxWidthCells: 40, fallback: '[image]' })
  other.render(80)
  const otherId = other.imageId!
  terminal.writes.length = 0
  facade.write('\x1b_')
  facade.write(`Ga=d,d=I,i=${otherId},q=2\x1b\\`)
  assert.ok(terminal.text.includes(`a=d,d=i,i=${otherId}`), 'the foreign-managed delete was still interpreted')
})

test('a managed placement split inside the introducer still gets its transmission', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  // Split exactly between ESC and `_G`.
  facade.write(anchor.slice(0, 1))
  facade.write(anchor.slice(1))
  assert.equal(count(terminal.text, 'a=t,f=100'), 1, 'the transmission is injected once')
  assert.ok(terminal.text.indexOf('a=t,f=100') < terminal.text.indexOf('a=p,'), 'and before the placement')
})

test('a failed frame write is never assumed to have landed', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  // The very first write (payload + placement) fails.
  terminal.failWhen = () => true
  assert.throws(() => facade.write(anchor), /terminal write failed/)

  // The error was not swallowed, and the Core did not claim the bytes arrived:
  // the next placement re-sends the payload instead of silently omitting it.
  terminal.writes.length = 0
  facade.write(anchor)
  assert.equal(count(terminal.text, 'a=t,f=100'), 1, 'the payload is sent again')
  assert.ok(terminal.text.indexOf('a=t,f=100') < terminal.text.indexOf('a=p,'))
})

test('a failed retire write keeps the id queued instead of claiming release', () => {
  const { terminal, facade, core } = harness()
  const image = core.register(source())!
  // Uploaded, never placed: its retire is the safe case.
  core.retire(image)
  terminal.failWhen = (data) => data.includes('a=d')
  assert.throws(() => facade.write('frame'), /terminal write failed/)
  assert.equal(core.owns(image.imageId), true, 'the failed retire was rolled back, not committed')

  // The next write retries the SAME retire and commits it only on success.
  facade.write('frame')
  assert.equal(count(terminal.text, `a=d,d=I,i=${image.imageId}`), 2, 'the retire was offered again')
  assert.equal(core.owns(image.imageId), false, 'and committed only after a successful write')
})

test('clearScreen invalidates the Core even though it bypasses write()', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  facade.write(anchor)
  assert.equal(count(terminal.text, 'a=t,f=100'), 1)
  terminal.writes.length = 0
  facade.clearScreen()
  facade.write(anchor)
  assert.equal(count(terminal.text, 'a=t,f=100'), 1, 'the cleared payload is sent again')
})

test('the gate joins a graphics command split across writes', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  const cut = Math.floor(anchor.length / 2)
  facade.write(`prefix${anchor.slice(0, cut)}`)
  assert.equal(terminal.text, 'prefix', 'an incomplete command is not forwarded')
  facade.write(`${anchor.slice(cut)}suffix`)
  assert.ok(terminal.text.startsWith('prefix'), 'the text before the command is never held back')
  assert.ok(terminal.text.endsWith(`${anchor}suffix`), 'the joined command and its tail follow in order')
  assert.equal(count(terminal.text, 'a=t,f=100'), 1, 'the injection still happens exactly once')
})

test('the gate joins a plain clear split across writes', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  facade.write(anchor)
  terminal.writes.length = 0
  facade.write('\x1b[2')
  facade.write(`J${anchor}`)
  assert.equal(terminal.text, `\x1b[2J${terminal.text.slice('\x1b[2J'.length)}`, 'the clear is replayed verbatim')
  assert.ok(terminal.text.indexOf('a=t,f=100') > terminal.text.indexOf('\x1b[2J'))
})

test('a screen-buffer switch invalidates residency', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  const anchor = component.render(80)[0]!
  facade.write(anchor)
  terminal.writes.length = 0
  facade.write(`\x1b[?1049h${anchor}`)
  assert.equal(count(terminal.text, 'a=t,f=100'), 1, 'the new buffer has no copy of the data')
})

test('a never-painted occurrence is queued and hard-retired by the next write', () => {
  const { terminal, facade, core } = harness()
  // Uploaded, but no placement ever landed: no screen or scrollback can
  // reference it, so its bytes are safe to release.
  const image = core.register(source())!
  facade.write(core.transmissionFor(image.imageId, 'main'))
  core.retire(image)
  terminal.writes.length = 0
  facade.write('after')
  assert.ok(terminal.text.startsWith(encodeKittyDeleteImage(image.imageId)), 'the hard retire precedes the frame')
  assert.ok(terminal.text.endsWith('after'), 'the frame is still written')
})

test('a PAINTED occurrence is terminal-retained: never hard-deleted, id never reused', () => {
  const { terminal, facade, core } = harness()
  const first = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(first.render(80).join('\r\n'))
  const firstImageId = first.imageId!
  // The component goes away (transcript trim / rebuild), but its pixels may
  // still be in the viewport or the scrollback.
  first.dispose()
  terminal.writes.length = 0
  facade.write('after')
  assert.ok(!terminal.text.includes('a=d'), 'the Core never frees a painted image')
  assert.equal(core.residentPayloadBytes, 0, 'its own payload copy is released')

  const second = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  second.render(80)
  assert.notEqual(second.imageId, firstImageId, 'a retained id is never handed out again')
})

test('a session-long run of painted thumbnails never exhausts the budget', () => {
  const { core, facade } = harness()
  // 100 distinct occurrences, each painted and then gone: the terminal keeps
  // their pixels, so none of them may hold an app-side slot or be re-used.
  const seen = new Set<number>()
  for (let index = 0; index < 100; index++) {
    const component = new NativeKittyImage(core, source(PNG, 4, 4), { maxWidthCells: 40, fallback: '[image]' })
    facade.write(component.render(80).join('\r\n'))
    const imageId = component.imageId!
    assert.equal(seen.has(imageId), false, `occurrence ${index} got a fresh id`)
    seen.add(imageId)
    component.dispose()
    assert.equal(core.residentImageCount, 0, 'a painted occurrence leaves the ACTIVE set')
    assert.equal(core.residentPayloadBytes, 0, 'and keeps no payload')
  }
  assert.ok(core.register(source(PNG, 4, 4)), 'a new occurrence still admits after 100 images')
  for (const imageId of seen) assert.equal(core.ownsIdSpace(imageId), true, 'every id stayed in the Core slice')
})

test('the decoded budget refuses an occurrence it cannot hold', () => {
  const { core } = harness()
  const side = Math.floor(Math.sqrt(MAX_RESIDENT_DECODED_BYTES / 4)) + 1
  assert.equal(core.register(source(PNG, side, side)), undefined, 'the decoded ceiling is enforced')
})

test('a retained id stays recognizable with no per-image bookkeeping', () => {
  const { core, facade, terminal } = harness()
  const retained: number[] = []
  // Retire MANY painted occurrences, then exercise the OLDEST one: a bounded
  // recognition window would have forgotten it by now.
  for (let index = 0; index < 600; index++) {
    const component = new NativeKittyImage(core, source(PNG, 4, 4), { maxWidthCells: 40, fallback: '[image]' })
    facade.write(component.render(80).join('\r\n'))
    retained.push(component.imageId!)
    component.dispose()
  }
  assert.equal(core.residentImageCount, 0, 'painted occurrences leave the active set')

  for (const imageId of [retained[0]!, retained[299]!, retained[599]!]) {
    terminal.writes.length = 0
    facade.write(encodeKittyDeleteImage(imageId))
    assert.equal(terminal.text, encodeKittyDeletePlacement(imageId),
      'the legacy delete stayed a placement removal, never a hard delete')
  }
})

test('the alternate screen still releases an id it painted before it retired', () => {
  const { core, facade, terminal } = harness()
  facade.write('\x1b[?1049h')
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(component.render(80).join('\r\n'))
  const imageId = component.imageId!
  // Esc back to the list: the Viewer panel goes away, the pixels do not.
  component.dispose()
  assert.equal(core.owns(imageId), false, 'the occurrence left the active ledger')
  terminal.writes.length = 0
  // Second Esc closes the workspace: the alternate screen's own global release.
  facade.write('\x1b_Ga=d,d=A,q=2\x1b\\')
  assert.ok(terminal.text.includes(encodeKittyDeleteImage(imageId)),
    'the alternate screen released the id IT painted')

  // A later close of a fresh alternate session must not release it again.
  terminal.writes.length = 0
  facade.write('\x1b[?1049l')
  facade.write('\x1b[?1049h')
  facade.write('\x1b_Ga=d,d=A,q=2\x1b\\')
  assert.ok(!terminal.text.includes(`i=${imageId}`), 'that session is over')
})

test('an alt repaint clear also removes a retired image\'s placement', () => {
  const { core, facade, terminal } = harness()
  facade.write('\x1b[?1049h')
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(component.render(80).join('\r\n'))
  const imageId = component.imageId!
  // The occurrence goes away: its pixels stay, its active record does not.
  component.dispose()
  terminal.writes.length = 0
  // The alternate screen repaints because the image anchor changed and emits
  // its scoped placement delete (`d=a`). Erasing text never erases graphics,
  // so the retired image's placement must be removed explicitly.
  facade.write('\x1b_Ga=d,d=a,q=2\x1b\\')
  assert.ok(terminal.text.includes(encodeKittyDeletePlacement(imageId)),
    'the retired image\'s placement is removed')
  assert.ok(!terminal.text.includes('d=a'), 'the global form never reaches the terminal')
  // A MAIN-retained image is never in the alt session's set, so an alt repaint
  // can never touch it.
  assert.ok(!terminal.text.includes(`a=d,d=I,i=${imageId}`), 'and its data is not freed here')
})

test('a clear inside the alternate session does not end its placement ownership', () => {
  const { core, facade, terminal } = harness()
  facade.write('\x1b[?1049h')
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(component.render(80).join('\r\n'))
  const imageId = component.imageId!
  component.dispose()
  // A repaint clear inside the SAME alternate session: residency dies, the
  // session (and therefore the id it still owns) does not.
  facade.write('\x1b[2J')
  terminal.writes.length = 0
  facade.write('\x1b_Ga=d,d=A,q=2\x1b\\')
  assert.ok(terminal.text.includes(encodeKittyDeleteImage(imageId)),
    'the alternate screen still releases the id it painted')
})

test('a failed global delete keeps every id retryable', () => {
  const { terminal, facade, core } = harness()
  // One live image placed in alt, plus one already retired (retained) alt id.
  facade.write('\x1b[?1049h')
  const live = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(live.render(80).join('\r\n'))
  const liveId = live.imageId!
  const retired = new NativeKittyImage(core, source('AAAA', 16, 16), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(retired.render(80).join('\r\n'))
  const retiredId = retired.imageId!
  retired.dispose()
  assert.equal(core.owns(retiredId), false, 'the retired occurrence left the active ledger')

  // The alt screen's own release write fails after possibly reaching the sink.
  terminal.writes.length = 0
  terminal.failWhen = (data) => data.includes('a=d')
  assert.throws(() => facade.write('\x1b_Ga=d,d=A,q=2\x1b\\'), /terminal write failed/)

  // Ownership was NOT consumed: the retry still frees both ids.
  terminal.writes.length = 0
  facade.write('\x1b_Ga=d,d=A,q=2\x1b\\')
  const text = terminal.text
  assert.ok(text.includes(encodeKittyDeleteImage(liveId)), 'the live id is still released on retry')
  assert.ok(text.includes(encodeKittyDeleteImage(retiredId)), 'and so is the already-retired one')
})

test('a committed global delete releases only the ids of its own buffer', () => {
  const { terminal, facade, core } = harness()
  // Main-placed image and an alt-placed image, then an alt release.
  const main = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(main.render(80).join('\r\n'))
  const mainId = main.imageId!
  facade.write('\x1b[?1049h')
  const alt = new NativeKittyImage(core, source('AAAA', 16, 16), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(alt.render(80).join('\r\n'))
  const altId = alt.imageId!

  terminal.writes.length = 0
  facade.write('\x1b_Ga=d,d=A,q=2\x1b\\')
  const text = terminal.text
  assert.ok(text.includes(encodeKittyDeleteImage(altId)), 'the alt buffer releases its own id')
  assert.ok(!text.includes(`i=${mainId}`), 'the main screen image is never mentioned')
  // Committing the alt release did not touch the main image\\'s ownership.
  assert.equal(core.owns(mainId), true, 'the main image is still owned')
  assert.equal(core.owns(altId), true, 'the alt record survives (its component still holds it)')
})

test('a foreign id outside the Core slice still passes through', () => {
  const { core, facade, terminal } = harness()
  // Find an id outside this Core's reserved slice.
  let foreign = 0x123456
  while (core.ownsIdSpace(foreign)) foreign += 1
  facade.write(encodeKittyDeleteImage(foreign))
  assert.equal(terminal.text, encodeKittyDeleteImage(foreign), 'a foreign owner keeps its own delete')
})

test('the payload budget refuses an oversized resident set', () => {
  const { core } = harness()
  const big = 'A'.repeat(Math.floor(MAX_RESIDENT_PAYLOAD_BYTES / 2) + 4)
  assert.ok(core.register(source(big, 4, 4)))
  assert.equal(core.register(source(big, 4, 4)), undefined, 'the payload ceiling is enforced')
})

test('stop keeps a live registration and leaves painted images alone', () => {
  const { terminal, core, facade } = harness()
  const painted = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(painted.render(80).join('\r\n'))
  const paintedId = painted.imageId!
  // A live occurrence that was registered but whose placement never landed.
  const pending = new NativeKittyImage(core, source('AAAA', 8, 8), { maxWidthCells: 40, fallback: '[image]' })
  pending.render(80)
  const pendingId = pending.imageId!

  terminal.writes.length = 0
  facade.stop()
  assert.equal(core.owns(pendingId), true, 'the screen stop did not destroy a live registration')
  assert.ok(!terminal.text.includes(`a=d,d=I,i=${paintedId}`), 'a painted scrollback image is preserved')
  assert.ok(!terminal.text.includes(`a=d,d=I,i=${pendingId}`), 'nothing was freed at the stop')

  // The occurrence's own retire is what ends it.
  facade.write('frame')
  pending.dispose()
  facade.write('frame')
  assert.equal(core.owns(pendingId), false, 'the component retire released it')
})

test('the alternate screen release at stop frees the managed ids before the terminal stops', () => {
  const { terminal, facade, core } = harness()
  const component = new NativeKittyImage(core, source(), { maxWidthCells: 40, fallback: '[image]' })
  facade.write(component.render(80).join('\r\n'))
  const id = component.imageId!
  terminal.writes.length = 0
  // The fork's alternate screen emits its global release in beforeTerminalStop.
  facade.write('\x1b[?2026h\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?2026l')
  facade.stop()
  assert.ok(terminal.writes.join('').includes(encodeKittyDeleteImage(id)), 'the own image is released')
  assert.ok(!terminal.writes.join('').includes('d=A'), 'never the global form')
})

test('native admission follows the effective Direct Kitty capability with no brand allowlist', () => {
  const direct = [
    { name: 'Kitty', environment: { TERM_PROGRAM: 'kitty' } },
    { name: 'Ghostty', environment: { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' } },
    { name: 'lone Ghostty TERM', environment: { TERM: 'xterm-ghostty' } },
    { name: 'lone Ghostty resource directory', environment: { GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty' } },
    { name: 'WezTerm', environment: { TERM_PROGRAM: 'wezterm', WEZTERM_PANE: '0' } },
    { name: 'Warp', environment: { TERM_PROGRAM: 'WarpTerminal' } },
    { name: 'Tern', environment: { TERM_PROGRAM: 'tern' } },
    { name: 'unknown terminal with an explicit Kitty override', environment: { PI_IMAGE_PROTOCOL: 'kitty' } },
  ] as const
  for (const entry of direct) {
    withDetectedEnvironment(entry.environment, () => {
      assert.equal(getCapabilities().images, 'kitty', `${entry.name}: the fork really detects the Kitty capability`)
      assert.equal(admitsNativeKitty(entry.environment), true, `${entry.name}: the Direct Native path is admitted`)
      const graphics = createNativeKittyGraphics(new RecordingTerminal(), {}, entry.environment)
      assert.ok(graphics, `${entry.name}: the factory creates the managed handle`)
      graphics.dispose()
    })
  }

  // The multiplexer transport exclusions are not brand policy and stay put.
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  for (const environment of [
    { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-1000/default,1,0' },
    { TERM_PROGRAM: 'ghostty', ZELLIJ: '1' },
    { TERM_PROGRAM: 'ghostty', STY: '1' },
    { TERM_PROGRAM: 'ghostty', TERM: 'tmux-256color' },
    { TERM_PROGRAM: 'ghostty', TERM: 'screen-256color' },
    { TERM_PROGRAM: 'wezterm', WEZTERM_PANE: '0', TMUX: '/tmp/tmux-1000/default,1,0' },
    { TERM_PROGRAM: 'tern', ZELLIJ: '1' },
    { TERM_PROGRAM: 'herdr', KITTY_WINDOW_ID: '1' },
  ]) {
    assert.equal(admitsNativeKitty(environment), false, JSON.stringify(environment))
  }

  // A hard opt-out and a non-Kitty override stay closed even on a brand that
  // would otherwise be a positive.
  for (const protocol of ['none', '0', 'iterm2'] as const) {
    withDetectedEnvironment({ TERM_PROGRAM: 'wezterm', WEZTERM_PANE: '0', PI_IMAGE_PROTOCOL: protocol }, () => {
      assert.notEqual(getCapabilities().images, 'kitty', `${protocol}: the fork capability is not Kitty`)
      assert.equal(createNativeKittyGraphics(new RecordingTerminal()), undefined, `${protocol}: the factory is refused`)
    })
  }
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: true })
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'kitty' }), false, 'the capability must be Kitty')
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'tern' }), false, 'a null capability is never admitted')
  assert.equal(admitsNativeKitty({ TERM_PROGRAM: 'wezterm', PI_IMAGE_PROTOCOL: 'kitty' }), false,
    'the environment override cannot replace a null capability')
})

test('Direct WezTerm, Warp and Tern paint the ONE managed Core with no virtual or global delete', () => {
  const hosts = [
    { name: 'WezTerm', environment: { TERM_PROGRAM: 'wezterm', WEZTERM_PANE: '0' } },
    { name: 'Warp', environment: { TERM_PROGRAM: 'WarpTerminal' } },
    { name: 'Tern', environment: { TERM_PROGRAM: 'tern' } },
  ] as const
  for (const host of hosts) {
    withDetectedEnvironment(host.environment, () => {
      const terminal = new RecordingTerminal()
      const graphics = createNativeKittyGraphics(terminal, {}, host.environment)
      assert.ok(graphics, `${host.name}: the real environment reaches the factory`)
      const component = graphics.image(source(), { maxWidthCells: 40, fallback: '[image]' })
      graphics.terminal.write(component.render(80).join('\r\n'))
      const text = terminal.text
      assert.equal(count(text, 'a=t,f=100'), 1, `${host.name}: one managed transmission`)
      assert.equal(count(text, 'a=p,'), 1, `${host.name}: one managed placement`)
      assert.ok(text.indexOf('a=t,f=100') < text.indexOf('a=p,'), `${host.name}: transmission precedes placement`)
      assert.ok(!text.includes('a=T,'), `${host.name}: no fork legacy combined form`)
      assert.ok(!text.includes('\x1bPtmux;'), `${host.name}: no tmux DCS`)
      assert.ok(!text.includes(',U=1'), `${host.name}: no virtual placeholder flag`)
      assert.ok(!text.includes(KITTY_VIRTUAL_PLACEHOLDER), `${host.name}: no virtual placeholder cell`)

      const imageId = (component as NativeKittyImage).imageId!
      terminal.writes.length = 0
      graphics.terminal.write('\x1b_Ga=d,d=A,q=2\x1b\\')
      const cleared = terminal.text
      assert.ok(!cleared.includes('d=A'), `${host.name}: a legacy global delete never reaches the terminal`)
      assert.ok(cleared.includes(encodeKittyDeleteImage(imageId)), `${host.name}: the own image is released`)
      terminal.writes.length = 0
      graphics.terminal.write('\x1b_Ga=d,d=I,i=424242,q=2\x1b\\')
      assert.equal(terminal.text, '\x1b_Ga=d,d=I,i=424242,q=2\x1b\\', `${host.name}: a foreign id delete passes untouched`)
      graphics.dispose()
    })
  }
})

test('the Ghostty factory creates ONE native handle and paints native commands', () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const terminal = new RecordingTerminal()
  const graphics = createNativeKittyGraphics(terminal, {}, {
    TERM_PROGRAM: 'ghostty',
    TERM: 'xterm-256color',
  })
  assert.ok(graphics, 'the direct Ghostty topology admits the factory')
  assert.equal(graphics.mode, 'native')
  assert.equal(graphics.canPaint(), true)
  const image = graphics.image(source(), { maxWidthCells: 40, fallback: '[image]' })
  graphics.terminal.write(image.render(80).join('\r\n'))
  const text = terminal.text
  assert.equal(count(text, 'a=t,f=100'), 1, 'one managed transmission')
  assert.equal(count(text, 'a=p,'), 1, 'one managed placement')
  assert.ok(text.indexOf('a=t,f=100') < text.indexOf('a=p,'), 'the transmission precedes the placement')
  assert.ok(!text.includes('\x1bPtmux;'), 'Ghostty is never the tmux virtual transport')
  assert.ok(!text.includes(',U=1'), 'no virtual placeholder flag')
  assert.ok(!text.includes(KITTY_VIRTUAL_PLACEHOLDER), 'no virtual placeholder cell')
  graphics.dispose()
})

test('the real PI_IMAGE_PROTOCOL=none environment refuses the Ghostty factory', () => {
  withDetectedEnvironment({
    TERM_PROGRAM: 'ghostty',
    TERM: 'xterm-256color',
    PI_IMAGE_PROTOCOL: 'none',
  }, () => {
    assert.equal(getCapabilities().images, null, 'the hard opt-out wins over the Ghostty capability hint')
    assert.equal(createNativeKittyGraphics(new RecordingTerminal()), undefined,
      'the production composition creates no managed handle')
  })
})

test('the real Ghostty environment reaches the factory through the fork capability', () => {
  withDetectedEnvironment({ TERM_PROGRAM: 'ghostty', TERM: 'xterm-256color' }, () => {
    assert.equal(getCapabilities().images, 'kitty', 'the fork really classifies the detected environment')
    const graphics = createNativeKittyGraphics(new RecordingTerminal())
    assert.ok(graphics, 'the real environment to factory path admits Ghostty')
    assert.equal(graphics.mode, 'native')
    graphics.dispose()
  })
})

test('ordinary text and OSC sequences pass through byte-for-byte', () => {
  const { terminal, facade } = harness()
  const text = 'hello \x1b[31mred\x1b[0m \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ \x1b]52;c;YWJj\x07'
  facade.write(text)
  assert.equal(terminal.text, text)
})


/**
 * Image-7B-A — the virtual mode of the SAME Core. These cases prove the one
 * mode branch (residency slot + writer-delete strategy) without a second
 * ledger, and that the Native contract above is untouched.
 */
test('a tmux virtual Core keeps ONE outer residency slot across both screen buffers', () => {
  const core = new KittyGraphicsCore({ placementMode: 'tmux-virtual' })
  const image = core.register(source())!
  assert.ok(core.transmissionFor(image.imageId, 'main').includes('a=t,f=100'))
  assert.equal(core.transmissionFor(image.imageId, 'alt'), '',
    'the alternate screen shares the one outer image namespace')
  core.invalidateResidency('main', '2J')
  assert.ok(core.transmissionFor(image.imageId, 'alt').includes('a=t,f=100'),
    'a real clear re-opens the slot for either screen')
})

test('a tmux virtual writer delete is layout intent; only an unpainted retire emits a delete', () => {
  const core = new KittyGraphicsCore({ placementMode: 'tmux-virtual' })
  const painted = core.register(source())!
  assert.equal(core.translateWriterDelete(painted.imageId), '')
  assert.equal(core.translateGlobalPlacementDelete('main'), '')
  assert.deepEqual(core.planGlobalImageDelete('main'), { buffer: 'main', wire: '', released: [], retained: [] })
  assert.equal(core.owns(painted.imageId), true, 'a writer delete never frees ownership')

  core.transmissionFor(painted.imageId, 'alt')
  core.notePlacement(painted.imageId, 'alt')
  core.retire(painted)
  assert.equal(core.owns(painted.imageId), false, 'the painted occurrence leaves the active set')
  assert.equal(core.hasQueuedRetirements(), false, 'terminal-retained pixels get no hard delete')
  assert.equal(core.residentPayloadBytes, 0, 'the Core frees only its own payload copy')

  const pending = core.register(source('AAAA', 8, 8))!
  core.transmissionFor(pending.imageId, 'main')
  core.retire(pending)
  assert.equal(core.hasQueuedRetirements(), true, 'a never-placed upload is safe to release')
  const { wire, ids } = core.takeRetirements()
  assert.ok(wire.includes(`a=d,d=I,i=${pending.imageId}`))
  core.rollbackRetirements(ids)
  assert.equal(core.hasQueuedRetirements(), true, 'a failed retire offer is put back')
})

test('a virtual write failure clears the shared outer residency slot', () => {
  const core = new KittyGraphicsCore({ placementMode: 'tmux-virtual' })
  const image = core.register(source())!
  core.transmissionFor(image.imageId, 'alt')
  core.noteWriteFailure([image.imageId], 'alt')
  assert.ok(core.transmissionFor(image.imageId, 'main').includes('a=t,f=100'),
    'the next placement re-sends after the ambiguous failure')
})

test('the native factory advertises native mode and always canPaint', () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const environment: NodeJS.ProcessEnv = { TERM_PROGRAM: 'kitty', KITTY_WINDOW_ID: '3', TERM: 'xterm-kitty' }
  const graphics = createNativeKittyGraphics(new RecordingTerminal(), {}, environment)
  assert.ok(graphics)
  assert.equal(graphics.mode, 'native')
  assert.equal(graphics.canPaint(), true)
  graphics.dispose()
})


test('a revoked handle can discard a never-painted retirement without terminal IO', () => {
  const core = new KittyGraphicsCore({ placementMode: 'tmux-virtual' })
  const pending = core.register(source())!
  core.transmissionFor(pending.imageId, 'main')
  core.retire(pending)
  assert.equal(core.hasQueuedRetirements(), true)
  core.discardQueuedRetirements()
  assert.equal(core.hasQueuedRetirements(), false)
  assert.equal(core.owns(pending.imageId), false)
  assert.equal(core.residentPayloadBytes, 0, 'the local payload is released')
  assert.equal(core.takeRetirements().wire, '', 'and no d=I is ever emitted')
  assert.equal(core.ownsIdSpace(pending.imageId), true, 'the id still belongs to the Core forever')
})

test('a pending tmux U1 probe never registers or paints a virtual occurrence', (t) => {
  const cli = createFakeTmuxCli(t)
  const terminal = new RecordingTerminal()
  try {
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\twezterm 20240203\n' })
    const graphics = createTmuxKittyGraphics(terminal, {}, cli.env)
    assert.ok(graphics)
    const image = graphics.image(
      { pngBase64: PNG, widthPx: 64, heightPx: 64 },
      { maxWidthCells: 20, maxHeightCells: 6, fallback: '[image]' },
    ) as TmuxKittyImage
    assert.equal(graphics.canPaint(), false)
    assert.deepEqual(image.render(80), ['[image]'], 'pending paints only text')
    assert.equal(image.imageId, undefined, 'pending never registers a Core occurrence')
    graphics.dispose()
  } finally {
    cli.dispose()
  }
})
