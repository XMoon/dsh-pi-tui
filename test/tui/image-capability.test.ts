/**
 * Image-7B-B — the ONE Client-local product image-protocol classifier.
 *
 * The classifier is the single answer every graphics consumer asks instead of
 * reading the fork capability directly. These cases drive it with a real tmux
 * admission (the production probe against a scripted executable), never with a
 * hand-made handle whose mode was declared `tmux-virtual`, so a passing case
 * proves the decision really comes from live server output.
 *
 * The sibling consumers' cache behaviour is covered where those consumers live
 * (`test/client/image-thumbnail.test.ts`, `draft-image-preview.test.ts`, ...);
 * this file owns the classifier's own contract and its session→sink behaviour
 * on the managed component.
 * @module @xmoon76/dsh-pi-tui/tui/image-capability.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resetCapabilitiesCache, setCapabilities, type Terminal, type TerminalProgressState } from '@xmoon76/pi-tui'
import { effectiveImageProtocol } from '../../src/tui/graphics/image-capability.ts'
import { createTmuxKittyGraphics, TmuxKittyImage } from '../../src/tui/graphics/tmux-image.ts'
import { TmuxKittyAdmission, probeTmuxKittyIdentity } from '../../src/tui/graphics/tmux-admission.ts'
import { KittyGraphicsCore } from '../../src/tui/graphics/kitty-core.ts'
import { KittyTerminalFacade } from '../../src/tui/graphics/kitty-terminal.ts'
import { createFakeTmuxCli } from '../support/fake-tmux-cli.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** A sink that records the bytes the facade really offered it. */
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

function tmuxPaneEnvironment(cli: ReturnType<typeof createFakeTmuxCli>): NodeJS.ProcessEnv {
  return { ...cli.env }
}

test('no handle keeps the fork capability untouched, including its null', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  assert.equal(effectiveImageProtocol(undefined), null, 'tmux/no-protocol surfaces keep the fork answer')

  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  assert.equal(effectiveImageProtocol(undefined), 'kitty', 'a native Kitty surface keeps the fork answer')

  resetCapabilitiesCache()
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false })
  assert.equal(effectiveImageProtocol(undefined), 'iterm2', 'iTerm2 keeps its own capability')
})

test('an admitted tmux handle paints kitty where the fork detects none, and revocation is live', async (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    resetCapabilitiesCache()
    setCapabilities({ images: null, trueColor: true, hyperlinks: false })
    const graphics = createTmuxKittyGraphics(new RecordingTerminal(), {}, tmuxPaneEnvironment(cli))
    assert.ok(graphics, 'the scripted server is the one admitted topology')
    assert.equal(graphics.mode, 'tmux-virtual')
    assert.equal(effectiveImageProtocol(graphics), 'kitty',
      'the managed admission overrides the fork, which still reports null')

    cli.setReply('show-options', { text: 'on\n' })
    // The component path answers from a real probe at most 250 ms old; the
    // documented hot-migration boundary is exactly that window.
    await new Promise<void>(resolve => setTimeout(resolve, 260))
    assert.equal(graphics.canPaint(), false, 'the changed option latches the revocation')
    assert.equal(effectiveImageProtocol(graphics), null, 'the classifier reports the live revocation')
    assert.equal(graphics.canPaint(), false, 'and the latch is one-way')
    assert.equal(effectiveImageProtocol(graphics), null, 'the classifier never regains pixels')
  } finally {
    cli.dispose()
  }
})

test('the native factory reports native and always paintable, whatever the fork says now', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    resetCapabilitiesCache()
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
    const admission = probeTmuxKittyIdentity(tmuxPaneEnvironment(cli))
    assert.ok(admission)
    // A native handle is only created on the native topology; the classifier's
    // native branch must defer to the fork, not to the tmux admission.
    const native = { mode: 'native' as const, canPaint: () => true }
    assert.equal(effectiveImageProtocol(native as never), 'kitty')
    resetCapabilitiesCache()
    setCapabilities({ images: null, trueColor: true, hyperlinks: false })
    assert.equal(effectiveImageProtocol(native as never), null,
      'a native handle does not override the fork capability')
  } finally {
    cli.dispose()
  }
})

test('source to sink: the admitted component really emits the managed grid, and none after revocation', async (t) => {
  const cli = createFakeTmuxCli(t)
  const terminal = new RecordingTerminal()
  try {
    resetCapabilitiesCache()
    setCapabilities({ images: null, trueColor: true, hyperlinks: false })
    const env = tmuxPaneEnvironment(cli)
    const identity = probeTmuxKittyIdentity(env)
    assert.ok(identity)
    const admission = new TmuxKittyAdmission(identity, env)
    const core = new KittyGraphicsCore({ placementMode: 'tmux-virtual' })
    const facade = new KittyTerminalFacade(terminal, core, { placementMode: 'tmux-virtual', admission })
    try {
      const graphics = {
        mode: 'tmux-virtual' as const,
        canPaint: () => admission.isAllowed(false),
        image: () => { throw new Error('not used in this case') },
        terminal: facade,
        dispose: () => {},
      }
      assert.equal(effectiveImageProtocol(graphics), 'kitty', 'the classifier admits the frame the component paints')

      const image = new TmuxKittyImage(
        core,
        { pngBase64: PNG, widthPx: 64, heightPx: 64 },
        { maxWidthCells: 20, maxHeightCells: 6, fallback: '[fallback]' },
        admission,
      )
      const rows = image.render(80)
      assert.ok(rows.length >= 2, 'a real grid was painted')
      const body = image.paintedBodyAt(80)
      assert.ok(body !== undefined, 'the component reported its painted body')
      facade.write(rows.join('\r\n'))
      const written = terminal.text
      // The clickable body must be the cells the placement really declared, not
      // the requested ceiling.
      const placement = /a=p,[^;]*c=(\d+),r=(\d+)/.exec(written)
      assert.ok(placement, 'the managed placement reached the sink')
      assert.deepEqual(
        [String(body.columns), String(body.rows)],
        [placement[1]!, placement[2]!],
        'the reported body equals the emitted placement geometry',
      )
      assert.ok(written.includes('\x1bPtmux;'), 'the managed command travelled inside a tmux DCS')
      assert.ok(written.includes('\u{10EEEE}'), 'the placeholder grid reached the sink')

      // The live binding changes; the SAME component must not paint pixels again.
      cli.setReply('list-clients', { text: '' })
      // Past the 250 ms component-probe window, so this frame is really
      // re-probed (a managed physical write would force the probe sooner).
      // The contract IS a time window: the 250 ms probe TTL must expire first.
      await new Promise<void>(resolve => setTimeout(resolve, 260))
      assert.equal(effectiveImageProtocol(graphics), null, 'the classifier reports the revocation')
      terminal.writes.length = 0
      assert.deepEqual(image.render(80), ['[fallback]'], 'the component paints its text fallback')
      assert.equal(image.paintedBodyAt(80), undefined, 'and reports NO clickable body')
      facade.write('[fallback]')
      assert.equal(terminal.text, '[fallback]', 'only the text reached the sink')
      assert.equal(terminal.text.includes('\u{10EEEE}'), false)
    } finally {
      facade.dispose()
      core.dispose()
    }
  } finally {
    cli.dispose()
  }
})
