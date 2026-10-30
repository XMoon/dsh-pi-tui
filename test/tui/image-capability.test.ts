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
import type { ImageGraphics } from '../../src/tui/graphics/native-image.ts'
import { createZellijKittyGraphics } from '../../src/tui/graphics/zellij-image.ts'
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
  private onInput: ((data: string) => void) | undefined

  get text(): string {
    return this.writes.join('')
  }

  start(onInput: (data: string) => void): void {
    this.onInput = onInput
  }

  sendInput(data: string): void {
    this.onInput?.(data)
  }
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

test('a native factory handle keeps its admitted state even when the fork cache changes later', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    resetCapabilitiesCache()
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
    const admission = probeTmuxKittyIdentity(tmuxPaneEnvironment(cli))
    assert.ok(admission)
    // A native handle is created only by an admitted factory; its `canPaint()`
    // is the admission fact every consumer must follow.
    const native = { mode: 'native' as const, canPaint: () => true }
    assert.equal(effectiveImageProtocol(native as never), 'kitty')
    resetCapabilitiesCache()
    setCapabilities({ images: null, trueColor: true, hyperlinks: false })
    assert.equal(effectiveImageProtocol(native as never), 'kitty',
      'the existing native handle does not re-read a changed fork cache')
    assert.equal(effectiveImageProtocol({ mode: 'native', canPaint: () => false } as never), null,
      'a native handle that reports no live pixels stays text')
  } finally {
    cli.dispose()
  }
})

test('a Zellij pane stays text-only until the live OK for every fork capability', async (t) => {
  const savedZellij = process.env.ZELLIJ
  const savedProtocol = process.env.PI_IMAGE_PROTOCOL
  t.after(() => {
    if (savedZellij === undefined) delete process.env.ZELLIJ
    else process.env.ZELLIJ = savedZellij
    if (savedProtocol === undefined) delete process.env.PI_IMAGE_PROTOCOL
    else process.env.PI_IMAGE_PROTOCOL = savedProtocol
    resetCapabilitiesCache()
  })
  process.env.ZELLIJ = '0'
  process.env.PI_IMAGE_PROTOCOL = 'kitty'
  for (const capability of ['kitty', 'iterm2', null] as const) {
    resetCapabilitiesCache()
    setCapabilities({ images: capability, trueColor: true, hyperlinks: false })
    assert.equal(effectiveImageProtocol(undefined), null,
      `fork images=${capability}: an unattended Zellij pane never becomes a legacy image path`)

    const terminal = new RecordingTerminal()
    const graphics = createZellijKittyGraphics(terminal, {}, {
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'tern',
      ZELLIJ: '1',
      ZELLIJ_SESSION_NAME: 'classifier-test',
    }, () => {})
    assert.ok(graphics, `fork images=${capability}: the candidate factory exists before its live answer`)
    assert.equal(effectiveImageProtocol(graphics), null, `fork images=${capability}: probing is text-only`)
    graphics.terminal.start(() => {}, () => {})
    const probeId = /a=q,i=(\d+)/.exec(terminal.text)?.[1]
    assert.ok(probeId)
    terminal.sendInput(`\x1b_Gi=${probeId};OK\x1b\\`)
    assert.equal(effectiveImageProtocol(graphics), 'kitty',
      `fork images=${capability}: the one-way live OK admits the same Native handle`)
    graphics.dispose()
  }

  const deniedTerminal = new RecordingTerminal()
  const denied = createZellijKittyGraphics(deniedTerminal, {}, {
    TERM: 'xterm-256color',
    TERM_PROGRAM: 'tern',
    ZELLIJ: '1',
  }, () => {})
  assert.ok(denied, 'a live rejection keeps the candidate handle')
  denied.terminal.start(() => {}, () => {})
  const deniedProbeId = /a=q,i=(\d+)/.exec(deniedTerminal.text)?.[1]
  assert.ok(deniedProbeId)
  deniedTerminal.sendInput(`\x1b_Gi=${deniedProbeId};ENOTSUPPORTED:disabled\x1b\\`)
  assert.equal(effectiveImageProtocol(denied), null, 'a denied admission stays text-only')
  denied.dispose()
})

test('an empty ZELLIJ marker is not a Zellij session', () => {
  const savedZellij = process.env.ZELLIJ
  try {
    process.env.ZELLIJ = ''
    resetCapabilitiesCache()
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
    assert.equal(effectiveImageProtocol(undefined), 'kitty',
      'the empty value must not suppress a direct terminal capability')
  } finally {
    if (savedZellij === undefined) delete process.env.ZELLIJ
    else process.env.ZELLIJ = savedZellij
    resetCapabilitiesCache()
  }
})

test('PI_IMAGE_PROTOCOL none/0 closes the Zellij candidate before any query or image work', () => {
  const savedZellij = process.env.ZELLIJ
  try {
    process.env.ZELLIJ = '1'
    for (const protocol of ['none', '0'] as const) {
      const terminal = new RecordingTerminal()
      const environment = {
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'ghostty',
        ZELLIJ: '1',
        PI_IMAGE_PROTOCOL: protocol,
      }
      assert.equal(createZellijKittyGraphics(terminal, {}, environment, () => {}), undefined, protocol)
      assert.equal(terminal.writes.length, 0, `${protocol}: no query byte`)
      assert.equal(effectiveImageProtocol(undefined), null, `${protocol}: text only`)
    }
  } finally {
    if (savedZellij === undefined) delete process.env.ZELLIJ
    else process.env.ZELLIJ = savedZellij
    resetCapabilitiesCache()
  }
})

test('an unknown tmux renderer stays text-only until the live e=T,U=1 feature reply', async (t) => {
  const cli = createFakeTmuxCli(t)
  const terminal = new RecordingTerminal()
  try {
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\twezterm 20240203\t0\n' })
    resetCapabilitiesCache()
    setCapabilities({ images: null, trueColor: true, hyperlinks: false })
    let repaints = 0
    const graphics = createTmuxKittyGraphics(terminal, {}, tmuxPaneEnvironment(cli), () => { repaints += 1 })
    assert.ok(graphics, 'the unknown renderer gets the pending managed handle')
    assert.equal(graphics.mode, 'tmux-virtual')
    assert.equal(graphics.canPaint(), false, 'pending feature proof paints no pixels')
    assert.equal(effectiveImageProtocol(graphics), null)
    graphics.terminal.start(() => {}, () => {})
    const query = /a=q,i=(\d+),e=T,U=1/.exec(terminal.text)
    assert.ok(query, 'the exact feature query was sent after the input listener started')
    const image = graphics.image(
      { pngBase64: PNG, widthPx: 64, heightPx: 64 },
      { maxWidthCells: 20, maxHeightCells: 6, fallback: '[fallback]' },
    )
    assert.deepEqual(image.render(80), ['[fallback]'], 'pending never registers or paints a virtual grid')
    assert.equal(terminal.text.includes('a=t,f=100'), false)

    terminal.sendInput(`\x1b_Gi=${query[1]},e=T,C=1,U=1;OK\x1b\\`)
    await Promise.resolve()
    assert.equal(graphics.canPaint(), true, 'the matching feature reply admits the same virtual handle')
    assert.equal(effectiveImageProtocol(graphics), 'kitty')
    assert.equal(repaints, 1, 'the product repaint callback fires exactly once')
    const rows = image.render(80)
    assert.ok(rows.join('').includes('\u{10EEEE}'), 'the admitted component paints the virtual grid')
    graphics.terminal.write(rows.join('\r\n'))
    assert.ok(terminal.text.includes('a=t,f=100') && terminal.text.includes('a=p,'))
    assert.ok(terminal.text.includes('\x1bPtmux;'), 'the managed command travels inside tmux DCS')
    graphics.dispose()
  } finally {
    cli.dispose()
  }
})

test('a base Kitty OK without e/U leaves an unknown renderer text-only', (t) => {
  const cli = createFakeTmuxCli(t)
  const terminal = new RecordingTerminal()
  try {
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\twezterm 20240203\t0\n' })
    resetCapabilitiesCache()
    setCapabilities({ images: null, trueColor: true, hyperlinks: false })
    const graphics = createTmuxKittyGraphics(terminal, {}, tmuxPaneEnvironment(cli))
    assert.ok(graphics)
    graphics.terminal.start(() => {}, () => {})
    const probeId = /a=q,i=(\d+)/.exec(terminal.text)?.[1]
    assert.ok(probeId)
    terminal.sendInput(`\x1b_Gi=${probeId};OK\x1b\\`)
    assert.equal(graphics.canPaint(), false, 'base Kitty OK is not U1 evidence')
    const image = graphics.image(
      { pngBase64: PNG, widthPx: 64, heightPx: 64 },
      { maxWidthCells: 20, maxHeightCells: 6, fallback: '[fallback]' },
    )
    assert.deepEqual(image.render(80), ['[fallback]'])
    assert.equal(terminal.text.includes('a=t,f=100'), false)
    graphics.dispose()
  } finally {
    cli.dispose()
  }
})

test('a screen stop between the U1 reply and the queued repaint drops only that repaint', async (t) => {
  const cli = createFakeTmuxCli(t)
  const terminal = new RecordingTerminal()
  try {
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\twezterm 20240203\t0\n' })
    resetCapabilitiesCache()
    setCapabilities({ images: null, trueColor: true, hyperlinks: false })
    let repaints = 0
    const graphics = createTmuxKittyGraphics(terminal, {}, tmuxPaneEnvironment(cli), () => { repaints += 1 })
    assert.ok(graphics)
    graphics.terminal.start(() => {}, () => {})
    const probeId = /a=q,i=(\d+),e=T,U=1/.exec(terminal.text)?.[1]
    assert.ok(probeId)
    terminal.sendInput(`\x1b_Gi=${probeId},e=T,U=1;OK\x1b\\`)
    graphics.terminal.stop()
    await Promise.resolve()
    assert.equal(graphics.canPaint(), true, 'the feature admission is one-way')
    assert.equal(repaints, 0, 'the stopped screen gets no repaint notification')
    graphics.terminal.start(() => {}, () => {})
    await Promise.resolve()
    assert.equal(repaints, 0, 'a stopped notification is never replayed on restart')
    assert.equal((terminal.text.match(/a=q,/g) ?? []).length, 1, 'restart never re-sends the query')
    graphics.dispose()
  } finally {
    cli.dispose()
  }
})

test('a disposed U1 handle never notifies the product from a late feature reply', async (t) => {
  const cli = createFakeTmuxCli(t)
  const terminal = new RecordingTerminal()
  try {
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\twezterm 20240203\t0\n' })
    resetCapabilitiesCache()
    setCapabilities({ images: null, trueColor: true, hyperlinks: false })
    let repaints = 0
    const graphics = createTmuxKittyGraphics(terminal, {}, tmuxPaneEnvironment(cli), () => { repaints += 1 })
    assert.ok(graphics)
    graphics.terminal.start(() => {}, () => {})
    const probeId = /a=q,i=(\d+),e=T,U=1/.exec(terminal.text)?.[1]
    assert.ok(probeId)
    graphics.dispose()
    terminal.sendInput(`\x1b_Gi=${probeId},e=T,U=1;OK\x1b\\`)
    await Promise.resolve()
    assert.equal(repaints, 0, 'a disposed handle never calls the repaint callback')
  } finally {
    cli.dispose()
  }
})

test('a client change during the pending U1 probe revokes before another client can authorize', async (t) => {
  const cli = createFakeTmuxCli(t)
  const terminal = new RecordingTerminal()
  try {
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\twezterm 20240203\t0\n' })
    resetCapabilitiesCache()
    setCapabilities({ images: null, trueColor: true, hyperlinks: false })
    const graphics = createTmuxKittyGraphics(terminal, {}, tmuxPaneEnvironment(cli))
    assert.ok(graphics)
    graphics.terminal.start(() => {}, () => {})
    const probeId = /a=q,i=(\d+),e=T,U=1/.exec(terminal.text)?.[1]
    assert.ok(probeId)

    cli.setReply('list-clients', { text: 'main\t/dev/pts/99\twork\txterm-256color\twezterm 20240203\t0\n' })
    terminal.sendInput(`\x1b_Gi=${probeId},e=T,U=1;OK\x1b\\`)
    await Promise.resolve()
    assert.equal(graphics.canPaint(), false, 'the other client’s feature reply never promotes the original identity')
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\twezterm 20240203\t0\n' })
    assert.equal(graphics.canPaint(), false, 'the identity revoke is one-way even after the original client returns')
    graphics.dispose()
  } finally {
    cli.dispose()
  }
})

test('a permanently denied U1 probe stops tmux CLI queries after the cache window', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const cli = createFakeTmuxCli(t)
  const terminal = new RecordingTerminal()
  try {
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\twezterm 20240203\t0\n' })
    resetCapabilitiesCache()
    setCapabilities({ images: null, trueColor: true, hyperlinks: false })
    const graphics = createTmuxKittyGraphics(terminal, {}, tmuxPaneEnvironment(cli))
    assert.ok(graphics)
    graphics.terminal.start(() => {}, () => {})
    const probeId = /a=q,i=(\d+)/.exec(terminal.text)?.[1]
    assert.ok(probeId)
    terminal.sendInput(`\x1b_Gi=${probeId};OK\x1b\\`)
    await Promise.resolve()
    assert.equal(graphics.canPaint(), false, 'base OK without e/U permanently denies the U1 proof')
    const callsAfterDenial = cli.calls().length

    t.mock.timers.tick(251)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal(graphics.canPaint(), false)
      const image = graphics.image(
        { pngBase64: PNG, widthPx: 64, heightPx: 64 },
        { maxWidthCells: 20, maxHeightCells: 6, fallback: '[fallback]' },
      )
      assert.deepEqual(image.render(80), ['[fallback]'])
    }
    assert.equal(cli.calls().length, callsAfterDenial, 'a denied handle must not spawn later tmux queries')
    graphics.dispose()
  } finally {
    cli.dispose()
  }
})

test('the known Kitty and Ghostty client reports skip the feature query', (t) => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  for (const report of [
    'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\n',
    'main\t/dev/pts/12\twork\txterm-256color\tkitty(0.41.1)\t0\n',
    'main\t/dev/pts/12\twork\txterm-ghostty\tghostty 1.4.0\t0\n',
    'main\t/dev/pts/12\twork\txterm-256color\tghostty 1.4.0\t0\n',
  ]) {
    const cli = createFakeTmuxCli(t)
    const terminal = new RecordingTerminal()
    try {
      cli.setReply('list-clients', { text: report })
      const graphics = createTmuxKittyGraphics(terminal, {}, tmuxPaneEnvironment(cli))
      assert.ok(graphics, report)
      graphics.terminal.start(() => {}, () => {})
      assert.equal(terminal.text.includes('a=q,'), false, `${report}: known evidence never sends a feature query`)
      assert.equal(graphics.canPaint(), true, `${report}: known evidence is immediately paintable`)
      graphics.dispose()
    } finally {
      cli.dispose()
    }
  }
})

test('PI_TUI_TMUX_KITTY_PLACEHOLDERS=1 replaces only the U1 proof and never bypasses hard-off', (t) => {
  const cli = createFakeTmuxCli(t)
  const terminal = new RecordingTerminal()
  try {
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\twezterm 20240203\t0\n' })
    cli.env.PI_TUI_TMUX_KITTY_PLACEHOLDERS = '1'
    resetCapabilitiesCache()
    setCapabilities({ images: null, trueColor: true, hyperlinks: false })
    const graphics = createTmuxKittyGraphics(terminal, {}, tmuxPaneEnvironment(cli))
    assert.ok(graphics)
    graphics.terminal.start(() => {}, () => {})
    assert.equal(terminal.text.includes('a=q,'), false, 'the explicit assertion skips the feature query')
    assert.equal(graphics.canPaint(), true, 'the live server identity still admits the handle')
    graphics.dispose()

    cli.env.PI_TUI_TMUX_KITTY_IMAGES = '0'
    assert.equal(createTmuxKittyGraphics(new RecordingTerminal(), {}, tmuxPaneEnvironment(cli)), undefined,
      'the assertion cannot bypass PI_TUI_TMUX_KITTY_IMAGES=0')
    cli.env.PI_TUI_TMUX_KITTY_IMAGES = '1'
    cli.env.PI_IMAGE_PROTOCOL = 'none'
    assert.equal(createTmuxKittyGraphics(new RecordingTerminal(), {}, tmuxPaneEnvironment(cli)), undefined,
      'the assertion cannot bypass PI_IMAGE_PROTOCOL=none')

    delete cli.env.PI_IMAGE_PROTOCOL
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\ttmux-256color\t\t0\n' })
    assert.equal(createTmuxKittyGraphics(new RecordingTerminal(), {}, tmuxPaneEnvironment(cli)), undefined,
      'the assertion cannot bypass a nested tmux/screen transport')
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

/**
 * The classifier reads exactly TWO members of a handle (`mode` and
 * `canPaint()`), so a minimal object is a faithful input for THIS contract — a
 * fuller fake would only restate the Kitty face the sibling files already own.
 */
function classifierHandle(mode: 'native' | 'tmux-virtual' | 'sixel', paints: boolean): ImageGraphics {
  return { mode, canPaint: () => paints } as unknown as ImageGraphics
}

test('Direct SIXEL is the last branch: it never overrides a managed handle and never invents pixels', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  assert.equal(effectiveImageProtocol(classifierHandle('sixel', true)), 'sixel', 'a ready Direct SIXEL owner answers sixel')
  assert.equal(effectiveImageProtocol(classifierHandle('sixel', false)), null, 'pending/denied SIXEL paints text')

  // A managed Kitty handle keeps precedence even while it cannot paint: a
  // revoked tmux pane must not silently degrade to a different protocol.
  assert.equal(effectiveImageProtocol(classifierHandle('native', true)), 'kitty')
  assert.equal(effectiveImageProtocol(classifierHandle('native', false)), null)
  assert.equal(effectiveImageProtocol(classifierHandle('tmux-virtual', false)), null)

  // The SIXEL owner is the authority even where the fork's own legacy detection
  // would answer iTerm2: `getCapabilities().images` never selects SIXEL.
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false })
  assert.equal(effectiveImageProtocol(classifierHandle('sixel', true)), 'sixel')
  assert.equal(effectiveImageProtocol(classifierHandle('sixel', false)), null, 'a denied SIXEL never falls back to iTerm2')
  assert.equal(effectiveImageProtocol(undefined), 'iterm2', 'no handle keeps the fork answer')
  resetCapabilitiesCache()
})

test('a managed native-tmux SIXEL handle is the only authority for that pane', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  assert.equal(effectiveImageProtocol(classifierHandle('sixel', true)), 'sixel',
    'the tmux SIXEL handle answers sixel even when the fork would answer kitty')
  assert.equal(effectiveImageProtocol(classifierHandle('sixel', false)), null,
    'a revoked native-tmux SIXEL handle never falls back to the fork capability')
  assert.equal(effectiveImageProtocol(classifierHandle('tmux-virtual', true)), 'kitty',
    'the tmux virtual Kitty handle keeps its own transport')
  resetCapabilitiesCache()
})
