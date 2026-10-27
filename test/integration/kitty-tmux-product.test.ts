/**
 * Image-7B-B — the tmux virtual backend through the REAL product composition.
 *
 * These cases build ONE `TuiApp` the production way (its single composition root
 * chooses the managed graphics handle) on top of a scripted but REAL `tmux`
 * executable, so the admission under test is produced by the production probe
 * from raw server output. The terminal is a recording sink the real
 * `TuiMainScreen` / `TuiAltScreen` write through, and the image consumers are the
 * production thumbnail / draft / viewer classes.
 *
 * What this file proves (E2) is the product wiring: one Core for both screens and
 * every consumer, the effective protocol classifier, the managed
 * `paintedBodyAt` click geometry, and revocation falling back to text with no
 * further APC/PUA, read or conversion. It is NOT the real outer GUI
 * qualification (that is the separate real-terminal E3).
 * @module @xmoon76/dsh-pi-tui/integration/kitty-tmux-product.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test, { afterEach, type TestContext } from 'node:test'
import { resetCapabilitiesCache, setCapabilities, type Terminal, type TerminalProgressState } from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { ImageCache } from '../../src/client/media/image/cache.ts'
import { convertKittyThumbnail } from '../../src/client/media/image/kitty-thumbnail.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import { SvgThumbnail } from '../../src/tui/components/media/svg-thumbnail.ts'
import { SVG_TOOL_NAME } from '../../src/domain/visual/tools.ts'
import { setAssistantVisualPresentation } from '../../src/domain/visual/presentation.ts'
import { svgHumanText } from '../../src/domain/visual/svg.ts'

import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'
import { effectiveImageProtocol } from '../../src/tui/graphics/image-capability.ts'
import type { KittyGraphics } from '../../src/tui/graphics/native-image.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { createFakeTmuxCli, type FakeTmuxCli } from '../support/fake-tmux-cli.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'

const SAMPLE_PNG = readFileSync(new URL('../fixtures/images/transcript-sample.png', import.meta.url))
const PLACEHOLDER = '\u{10EEEE}'
const DCS = /\x1bPtmux;(?:[^\x1b]|\x1b\x1b)*\x1b\\/g

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

/**
 * Apply the scripted pane environment (the production factories read
 * `process.env`) and restore it afterwards. The fixture executable is first on
 * PATH, so the production probe still crosses the real subprocess boundary.
 */
function useTmuxEnvironment(t: TestContext, cli: FakeTmuxCli): void {
  const saved = new Map<string, string | undefined>()
  for (const key of [...Object.keys(cli.env), 'KITTY_WINDOW_ID', 'TERM_PROGRAM', 'ZELLIJ', 'STY', 'PI_IMAGE_PROTOCOL']) {
    saved.set(key, process.env[key])
    const value = cli.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

class RecordingTerminal implements Terminal {
  readonly writes: string[] = []
  columns = 100
  rows = 40
  kittyProtocolActive = false
  /** The real input handler the app installed through `start()`. */
  private onInput: ((data: string) => void) | undefined

  get text(): string {
    return this.writes.join('')
  }

  start(onInput: (data: string) => void): void {
    this.onInput = onInput
  }

  /** The sink face the harness uses (unused by the byte-level cases). */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
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

/**
 * A REAL terminal emulator as the product sink, for the one case that clicks
 * painted cells: the pointer route needs the rows the frame actually painted,
 * so the screen must be a genuine emulator rather than a byte recorder.
 */
function virtualSink(): SinkTerminal {
  const vt = new VirtualTerminal(100, 40)
  const writes: string[] = []
  const write = vt.write.bind(vt)
  vt.write = (data: string): void => {
    writes.push(data)
    write(data)
  }
  // `VirtualTerminal` implements the terminal surface with looser parameter
  // signatures than the interface it satisfies, so the adapter declares the
  // interface's shape explicitly instead of forwarding by inference.
  const emit = vt as unknown as Terminal
  return {
    get writes() {
      return writes
    },
    get columns() {
      return vt.columns
    },
    get rows() {
      return vt.rows
    },
    get kittyProtocolActive() {
      return false
    },
    start: (onInput: (data: string) => void, onResize: () => void) => {
      ;(emit.start as (a: (data: string) => void, b: () => void) => void)(onInput, onResize)
    },
    stop: () => emit.stop(),
    drainInput: () => (emit.drainInput as () => Promise<void>)(),
    write: (data: string) => vt.write(data),
    moveBy: (lines: number) => emit.moveBy(lines),
    hideCursor: () => emit.hideCursor(),
    showCursor: () => emit.showCursor(),
    clearLine: () => emit.clearLine(),
    clearFromCursor: () => emit.clearFromCursor(),
    clearScreen: () => emit.clearScreen(),
    setTitle: (title: string) => emit.setTitle(title),
    setProgress: (active: boolean) => emit.setProgress(active),
    setProgramStatus: (status) => emit.setProgramStatus(status),
    setProgressState: (state: TerminalProgressState) => {
      ;(emit.setProgressState as ((s: TerminalProgressState) => void) | undefined)?.(state)
    },
    sendInput: (data: string) => vt.sendInput(data),
    // The emulator's own settle/viewport API: the case asserts on what the
    // screen REALLY painted, not on the bytes it was offered.
    flush: () => vt.flush(),
    getViewport: () => vt.getViewport(),
  }
}

/** Wrap the byte recorder in the shared sink face. */
function recordingSink(): SinkTerminal {
  const inner = new RecordingTerminal()
  // The recorder's methods are deliberately argument-free stubs; the adapter
  // declares the interface's real arity here rather than forwarding by
  // inference.
  const surface = inner as unknown as Terminal
  return {
    get writes() {
      return inner.writes
    },
    get columns() {
      return inner.columns
    },
    get rows() {
      return inner.rows
    },
    get kittyProtocolActive() {
      return inner.kittyProtocolActive
    },
    start: (onInput, onResize) => surface.start(onInput, onResize),
    stop: () => surface.stop(),
    drainInput: () => surface.drainInput(),
    write: (data: string) => inner.write(data),
    moveBy: (lines: number) => surface.moveBy(lines),
    hideCursor: () => surface.hideCursor(),
    showCursor: () => surface.showCursor(),
    clearLine: () => surface.clearLine(),
    clearFromCursor: () => surface.clearFromCursor(),
    clearScreen: () => surface.clearScreen(),
    setTitle: (title: string) => surface.setTitle(title),
    setProgress: (active: boolean) => surface.setProgress(active),
    setProgramStatus: (status) => surface.setProgramStatus(status),
    setProgressState: (state) => surface.setProgressState?.(state),
    sendInput: (data: string) => inner.sendInput(data),
    async flush() {},
    getViewport: () => [],
  }
}

/** Wait for an authoritative fact, not a wall-clock window. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** Let the app's throttled frame pipeline settle (several frames get a chance). */
async function settle(app: TuiApp): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    app.requestRender()
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

/** Every tmux passthrough unit the pipeline really wrote. */
function units(text: string): string[] {
  return text.match(DCS) ?? []
}

/** The managed transmissions (`a=t`). */
function transmissions(text: string): string[] {
  return units(text).filter(unit => unit.includes('a=t'))
}

/** The managed virtual placements (`a=p,U=1`). */
function placements(text: string): string[] {
  return units(text).filter(unit => unit.includes('a=p') && unit.includes('U=1'))
}

/** Any Kitty APC that escaped its tmux DCS wrapper. */
function unwrappedApc(text: string): boolean {
  return text.replace(DCS, '').includes('\x1b_G')
}

/** The managed image ids of the transmissions that reached the sink. */
function transmissionIds(text: string): string[] {
  const ids: string[] = []
  for (const unit of transmissions(text)) {
    const id = /(?:^|,)i=(\d+)/.exec(unit)
    if (id !== null) ids.push(id[1]!)
  }
  return ids
}

/** The ONE terminal face the product harness needs from its sink. */
interface SinkTerminal extends Terminal {
  /** The raw bytes offered to this sink (mutable so a test can clear it). */
  writes: string[]
  sendInput(data: string): void
  flush(): Promise<void>
  getViewport(): string[]
}

interface ProductHarness {
  readonly cli: FakeTmuxCli
  readonly terminal: SinkTerminal
  readonly app: TuiApp
  readonly graphics: KittyGraphics | undefined
  readonly loader: ImageLoader
  readonly store: DraftImageStore
  readonly reads: Map<string, number>
  readonly conversions: () => number
  /** How many times the app's ONE injected SVG rasterizer really ran. */
  readonly rasterCalls: () => number
}

/** Build the REAL product composition on the scripted server. */
function product(
  t: TestContext,
  options: { optIn?: boolean; sink?: 'recording' | 'virtual' } = {},
): ProductHarness {
  // A tmux pane detects no inline protocol at all — the exact production
  // condition this backend exists for. The admission may therefore only come
  // from the live server probe.
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const cli = createFakeTmuxCli(t)
  if (options.optIn === false) delete cli.env.PI_TUI_TMUX_KITTY_IMAGES
  useTmuxEnvironment(t, cli)

  const reads = new Map<string, number>()
  let conversionCount = 0
  const loader = new ImageLoader(
    async (ref) => {
      reads.set(ref.attachmentId, (reads.get(ref.attachmentId) ?? 0) + 1)
      return { ref: {}, data: SAMPLE_PNG }
    },
    new ImageCache(),
    async (input, mediaType) => {
      conversionCount += 1
      return convertKittyThumbnail(input, mediaType)
    },
  )
  const terminal: SinkTerminal = options.sink === 'virtual'
    ? virtualSink()
    : recordingSink()
  let svgRasterCalls = 0
  const svgLoader = new SvgRasterLoader(async () => {
    svgRasterCalls += 1
    return { png: SAMPLE_PNG, base64: SAMPLE_PNG.toString('base64'), widthPx: 64, heightPx: 32 }
  })
  const store = new DraftImageStore()
  const app = new TuiApp(terminal, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text: string) => text },
    draftImagePreviewSource: { values: () => store.values() },
    draftImagePreviewLiveDraft: read => store.setLiveDraftTextSource(read),
    svgRasterLoader: svgLoader,
  })
  app.start()
  startedApps.add(app)
  const graphics = (app as unknown as { graphics: KittyGraphics | undefined }).graphics
  return {
    cli,
    terminal,
    app,
    graphics,
    loader,
    store,
    reads,
    conversions: () => conversionCount,
    rasterCalls: () => svgRasterCalls,
  }
}

function userMessage(content: unknown[], seq: number): never {
  return { type: 'user/message', seq, time: seq, data: { content, source: { kind: 'user' } } } as never
}

function pngRef(attachmentId: string, name: string): ImageAttachmentRefLike {
  return {
    attachmentId,
    mediaType: 'image/png',
    bytes: SAMPLE_PNG.byteLength,
    width: 120,
    height: 80,
    name,
  }
}

test('the real composition root admits the tmux virtual handle where the fork detects no protocol', (t) => {
  const h = product(t)
  assert.ok(h.graphics, 'the production composition created a managed handle')
  assert.equal(h.graphics.mode, 'tmux-virtual', 'the tmux transport was selected')
  assert.equal(h.graphics.canPaint(), true, 'the live server admits exactly one Kitty client')
  assert.equal(effectiveImageProtocol(h.graphics), 'kitty', 'the product classifier admits this frame')
  assert.equal((h.app as unknown as { terminal: unknown }).terminal, h.graphics.terminal,
    'the ONE facade is the terminal both screens write through')
  assert.equal(h.graphics.terminal.columns, h.terminal.columns, 'the facade reports the real geometry')
})

test('without the opt-in there is no handle and the transcript performs no read, APC or PUA', async (t) => {
  const h = product(t, { optIn: false })
  assert.equal(h.graphics, undefined, 'no opt-in means no managed handle')

  const ref = pngRef('att-noopt', 'noopt.png')
  const folder = new TranscriptFolder()
  folder.apply([userMessage([{ type: 'image', attachment: ref }], 1)])
  h.app.setTranscript(folder.messages())
  await settle(h.app)

  const painted = h.terminal.writes.join('')
  assert.equal(painted.includes('\x1b_G'), false, 'no Kitty APC was written')
  assert.equal(painted.includes(PLACEHOLDER), false, 'no placeholder grid was written')
  assert.equal(transmissions(painted).length, 0, 'no managed transmission')
  assert.equal(h.reads.get(ref.attachmentId), undefined, 'the refused surface read no payload bytes')
  assert.equal(h.conversions(), 0, 'the refused surface ran no conversion')
  assert.ok(/\u{1F5BC}/u.test(painted), 'the constant identity row is still painted as text')
})

test('one Core paints the transcript body, and its click body is the REAL painted footprint', async (t) => {
  const h = product(t)
  assert.ok(h.graphics)
  const ref = pngRef('att-png', 'shot.png')
  const folder = new TranscriptFolder()
  folder.apply([userMessage([{ type: 'image', attachment: ref }], 1)])
  h.app.setTranscript(folder.messages())
  await until(() => h.loader.get(ref).state === 'ready', 'the transcript PNG read')
  await settle(h.app)

  const text = h.terminal.writes.join('')
  assert.equal(unwrappedApc(text), false, 'every managed command travelled inside its own DCS')
  assert.ok(transmissions(text).length >= 1, `the transcript image was transmitted: ${JSON.stringify(text.slice(0, 160))}`)
  assert.ok(placements(text).length >= 1, 'the image was virtually placed')
  assert.ok(text.includes(PLACEHOLDER), 'the placeholder grid reached the sink')
  assert.equal(h.reads.get(ref.attachmentId), 1, 'the durable attachment was read once')

  const occurrences = (h.app as unknown as {
    mountedImageOccurrences(): { thumbnail: unknown }[]
  }).mountedImageOccurrences()
  assert.equal(occurrences.length, 1, 'fixture: one mounted occurrence')
  const thumbnail = occurrences[0]!.thumbnail as {
    paintedImageBody(width: number): { rows: number; endCol: number } | undefined
  }
  // The host hit-test measures at the transcript content width, so the
  // component is asked at THAT width — the same one the frame painted at.
  const contentWidth = (h.app as unknown as { transcriptRenderWidth(): number }).transcriptRenderWidth()
  const body = thumbnail.paintedImageBody(contentWidth)
  assert.ok(body !== undefined, `the managed thumbnail reported a clickable body at width ${contentWidth}`)
  assert.ok(body.rows >= 1 && body.endCol >= 1, `the body covers real cells: ${JSON.stringify(body)}`)
  assert.ok(body.endCol <= 40, `the body never exceeds the component ceiling: ${body.endCol}`)
})

test('a refused managed frame is repainted as ONE complete text frame, not a torn diff', async (t) => {
  // The refused write throws INSIDE the screen's `doRender()`, before it commits
  // the frame's lines, so a differential retry would diff against a frame the
  // terminal never received. This case uses a real emulator to prove the surface
  // ends up with exactly one of everything.
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const cli = createFakeTmuxCli(t)
  useTmuxEnvironment(t, cli)
  const loader = new ImageLoader(async () => ({ ref: {}, data: SAMPLE_PNG }), new ImageCache())
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text: string) => text },
  })
  app.start()
  startedApps.add(app)
  const graphics = (app as unknown as { graphics: KittyGraphics | undefined }).graphics
  assert.ok(graphics)

  const ref = pngRef('att-torn', 'torn.png')
  const folder = new TranscriptFolder()
  folder.apply([userMessage([{ type: 'image', attachment: ref }], 1)])
  app.setTranscript(folder.messages())
  for (let attempt = 0; attempt < 20; attempt += 1) {
    app.requestRender()
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  const admitted = vt.writes.join('')
  assert.ok(admitted.includes(PLACEHOLDER), 'the admitted frame painted the grid')

  // Revoke, then render once more inside the component's short probe TTL so the
  // frame still carries cached placeholder bytes and the facade's forced probe
  // really refuses the batch (the write path exception, not a text frame).
  cli.setReply('list-clients', { text: '' })
  vt.writes.length = 0
  app.requestRender(true)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    app.requestRender()
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  const recovered = vt.writes.join('')
  assert.equal(transmissions(recovered).length, 0, 'no managed transmission after revocation')
  assert.equal(recovered.includes(PLACEHOLDER), false, 'no placeholder cell after revocation')

  await vt.flush()
  const rows = vt.getViewport()
  const painted = rows.filter(row => row.trim() !== '')
  assert.ok(painted.some(row => row.includes('🖼️ torn.png')), `the identity row survived:\n${painted.join('\n')}`)
  assert.equal(painted.filter(row => row.includes('↑0 ↓0  t0/s0')).length, 1,
    `exactly ONE footer row was painted:\n${painted.join('\n')}`)
  assert.equal(painted.filter(row => row.startsWith('🐋  dsh-pi-tui')).length, 1,
    `exactly ONE header row was painted:\n${painted.join('\n')}`)
  assert.equal(painted.filter(row => row.startsWith('────')).length, 2,
    `the composer keeps its ONE border pair (a torn diff duplicates it):\n${painted.join('\n')}`)
})

test('revocation falls back to text with no further APC/PUA and no extra read or conversion', async (t) => {
  const h = product(t)
  assert.ok(h.graphics)
  const ref = pngRef('att-revoke', 'revoke.png')
  const folder = new TranscriptFolder()
  folder.apply([userMessage([{ type: 'image', attachment: ref }], 1)])
  h.app.setTranscript(folder.messages())
  await until(() => h.loader.get(ref).state === 'ready', 'the first PNG read')
  await settle(h.app)
  assert.ok(h.terminal.writes.join('').includes(PLACEHOLDER), 'the admitted frame painted placeholders')
  const readsBefore = h.reads.get(ref.attachmentId)
  const conversionsBefore = h.conversions()

  // The real client binding changes on the SERVER side.
  h.cli.setReply('list-clients', { text: '' })
  h.terminal.writes.length = 0
  await settle(h.app)

  assert.equal(effectiveImageProtocol(h.graphics), null, 'the product classifier reports the revoked latch')
  assert.equal(h.graphics.canPaint(), false, 'the underlying admission stays revoked')
  const after = h.terminal.writes.join('')
  assert.equal(transmissions(after).length, 0, 'no managed transmission escaped after revocation')
  assert.equal(placements(after).length, 0, 'no managed placement escaped after revocation')
  assert.equal(after.includes(PLACEHOLDER), false, 'no placeholder cell reached the sink after revocation')
  assert.equal(unwrappedApc(after), false, 'and nothing escaped unwrapped')
  assert.equal(h.reads.get(ref.attachmentId), readsBefore, 'the revoked surface re-read no payload')
  assert.equal(h.conversions(), conversionsBefore, 'the revoked surface ran no conversion')
  assert.ok(after.length > 0, 'a real text frame was still written')
})

/**
 * The E2 end-to-end product path required by plan §5: ONE `TuiApp` drives
 * Draft → submit → Transcript → Viewer → Esc, and every step is asserted on the
 * REAL sink bytes and on the real screen state (a case that observes nothing
 * must fail, not pass vacuously).
 */
test('ONE app drives draft -> submit -> transcript -> viewer -> Esc with the SAME Core', async (t) => {
  const h = product(t, { sink: 'virtual' })
  assert.ok(h.graphics)
  const vt = h.terminal as SinkTerminal & { flush(): Promise<void>; getViewport(): string[] }
  const settleFrames = async (): Promise<void> => {
    await settle(h.app)
    await vt.flush()
  }
  const staged = h.store.add({
    bytes: SAMPLE_PNG,
    mediaType: 'image/png',
    width: 120,
    height: 80,
    name: 'staged.png',
  })

  // 1. DRAFT: the composer card paints real pixels through the managed Core.
  h.app.setDraft(staged.placeholder)
  await settleFrames()
  const draftText = h.terminal.writes.join('')
  assert.ok(draftText.length > 0, 'the draft frame really wrote bytes')
  assert.ok(draftText.includes(PLACEHOLDER), 'the draft card painted the virtual grid')
  assert.equal(unwrappedApc(draftText), false, 'the draft batch was DCS-wrapped')
  assert.ok(transmissionIds(draftText).length >= 1, 'the draft card transmitted a managed image')
  assert.equal(h.reads.size, 0, 'the draft card never touched the DURABLE loader')

  // 2. SUBMIT through the REAL product gesture: the host sink receives the
  //    expanded draft, and the composer band leaves the screen.
  const submitted: string[] = []
  const events = (h.app as unknown as { events: { onSubmit: (text: string) => void } }).events
  const originalSubmit = events.onSubmit.bind(events)
  events.onSubmit = (text: string): void => {
    submitted.push(text)
    originalSubmit(text)
  }
  h.app.submitDraft('enter')
  await settleFrames()
  assert.deepEqual(submitted, [staged.placeholder], 'the production submit carried the draft once')
  assert.equal(h.app.getDraft(), '', 'the production submit cleared the draft')

  // 3. TRANSCRIPT: the durable ref the host would persist renders through the
  //    SAME app and the SAME Core. The sink is CLEARED at this stage boundary:
  //    the draft stage already transmitted its own image, so only the writes
  //    produced AFTER this point can prove the transcript transmission.
  h.terminal.writes.length = 0
  const ref = pngRef('att-e2e', 'staged.png')
  const folder = new TranscriptFolder()
  folder.apply([userMessage([{ type: 'image', attachment: ref }], 1)])
  h.app.setTranscript(folder.messages())
  await until(() => h.loader.get(ref).state === 'ready', 'the transcript durable read')
  await settleFrames()
  const transcriptView = vt.getViewport().join('\n')
  assert.ok(transcriptView.includes('🖼️ staged.png'),
    `the transcript identity row is on screen:\n${transcriptView}`)
  const transcriptText = h.terminal.writes.join('')
  assert.ok(transcriptText.length > 0, 'the transcript stage really wrote a frame')
  assert.ok(transmissionIds(transcriptText).length >= 1,
    `the transcript image itself was transmitted (draft writes excluded): ${JSON.stringify(transcriptText.slice(0, 120))}`)
  assert.equal(h.reads.get(ref.attachmentId), 1, 'exactly one durable read for the transcript')

  // 4. VIEWER through the REAL fullscreen pointer route on the painted body.
  h.app.setFullscreen(true)
  await settleFrames()
  const internals = h.app as unknown as {
    mountedImageOccurrences(): { thumbnail: { paintedImageBody(width: number): { rows: number; endCol: number } | undefined } }[]
    transcriptRenderWidth(): number
  }
  const occurrences = internals.mountedImageOccurrences()
  assert.equal(occurrences.length, 1, 'fixture: one mounted occurrence')
  const body = occurrences[0]!.thumbnail.paintedImageBody(internals.transcriptRenderWidth())
  assert.ok(body !== undefined, 'the transcript body is a real painted hit target')

  const rows = vt.getViewport()
  // The INFO bar is the row carrying the identity FACTS (`· WxH · bytes`); the
  // composer echo row above it also contains the emoji and the name, so the
  // needle must be the fact row itself.
  const infoRow = rows.findIndex(row => row.includes('120×80 · 258 B'))
  assert.ok(infoRow >= 0, `the info row is on the fullscreen screen:\n${rows.join('\n')}`)
  // `y` is 1-based on the wire and becomes 0-based in the screen: the body's
  // first painted row is the row AFTER the info row, i.e. `infoRow + 1` in
  // indexes → `infoRow + 2` on the wire.
  const clickRow = infoRow + 2
  const clickCol = Math.max(1, Math.min(4, body.endCol))
  h.terminal.writes.length = 0
  vt.sendInput(`\x1b[<0;${clickCol};${clickRow}M`)
  vt.sendInput(`\x1b[<0;${clickCol};${clickRow}m`)
  await settleFrames()
  const viewer = vt.getViewport().join('\n')
  assert.ok(viewer.includes('Esc'), `the Viewer painted its own chrome:\n${viewer}`)
  assert.ok(viewer.includes('Image · staged.png'), `the Viewer opened on the clicked occurrence:\n${viewer}`)
  const viewerText = h.terminal.writes.join('')
  assert.ok(viewerText.includes(PLACEHOLDER), 'the Viewer painted real pixels')
  assert.equal(unwrappedApc(viewerText), false, 'the Viewer batch was DCS-wrapped')
  assert.equal(h.reads.get(ref.attachmentId), 1, 'the Viewer re-read no durable bytes')

  // 5. ESC returns to the transcript: the frame must be RESTORED, not empty.
  h.terminal.writes.length = 0
  vt.sendInput('\x1b')
  await settleFrames()
  const restored = vt.getViewport().join('\n')
  assert.ok(restored.includes('🖼️ staged.png'), `the transcript was restored after Esc:\n${restored}`)
  assert.equal(restored.includes('Image · staged.png'), false, 'the Viewer is gone')
  assert.equal(h.reads.get(ref.attachmentId), 1, 'the whole round trip read the payload once')
  h.app.setFullscreen(false)
  await settleFrames()
})

test('a REAL SVG tool message is authorized and thumbnailed by the app\'s OWN raster loader', async (t) => {
  // Evidence scope, stated precisely: a durable TOOL MESSAGE (the way the Host
  // delivers it) goes through the app's own card renderer, which authorizes the
  // SVG and mounts an inline raster produced by the ONE `SvgRasterLoader` the
  // app was constructed with.
  //
  // This case does NOT open the SVG Viewer and does NOT copy: a tool-card SVG
  // exposes the inline raster only, while the View/Copy affordances belong to
  // the Assistant PUBLICATION path (`visualFigureHandles` → `openSvgViewer` /
  // `copyVisualPayload`). The Viewer's own Preview/Source/Copy/resize contract is
  // covered by `test/client/svg-viewer.test.ts`.
  const h = product(t, { sink: 'virtual' })
  assert.ok(h.graphics)
  const vt = h.terminal as SinkTerminal & { flush(): Promise<void>; getViewport(): string[] }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
    + '<rect width="64" height="32" fill="#3b82f6"/></svg>'

  const svgFact = {
    version: 1,
    type: 'svg',
    title: 'Service topology',
    description: 'Gateway -> App',
    digest: createHash('sha256').update(svg, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(svg, 'utf8'),
  }
  // The EXACT row shape the Host produces for an SVG tool call: `result` is the
  // durable human text and the LAST block is the machine credential.
  const svgFactWithVersion = {
    version: 1 as const,
    type: 'svg' as const,
    title: 'Service topology',
    description: 'Gateway -> App',
    digest: svgFact.digest,
    bytes: svgFact.bytes,
  }
  const human = svgHumanText(svgFactWithVersion)
  const toolMessage = {
    kind: 'tool',
    turn: 1,
    name: SVG_TOOL_NAME,
    args: JSON.stringify({ title: 'Service topology', description: 'Gateway -> App', svg }),
    result: human,
    resultBlocks: [
      { type: 'text', text: human },
      { type: 'text', text: `visual-v1:${JSON.stringify(svgFactWithVersion)}` },
    ],
    status: 'ok',
  } as never
  h.terminal.writes.length = 0
  const appInternal = h.app as unknown as {
    setTranscript(messages: unknown[]): void
    messages: readonly unknown[]
    toggleMessageExpanded(message: unknown): void
    requestRender(): void
  }
  appInternal.setTranscript([toolMessage])
  // Expand the card through the app's OWN disclosure owner: the SVG body (and
  // its inline raster) is part of the expanded card.
  appInternal.toggleMessageExpanded(appInternal.messages[0])
  // The thumbnail is an ASYNC raster: wait for the injected loader to settle.
  await settle(h.app)
  await vt.flush()
  await until(() => {
    ;(h.app as unknown as { requestRender(): void }).requestRender()
    return (h.rasterCalls() ?? 0) >= 1
  }, 'the app rasterized the SVG through its own loader')
  await settle(h.app)
  await vt.flush()
  const thumbText = h.terminal.writes.join('')
  assert.ok(thumbText.length > 0, 'the SVG card painted a frame')
  assert.ok(thumbText.includes(PLACEHOLDER),
    `the app's own SVG thumbnail painted through the managed handle: ${JSON.stringify(thumbText.slice(0, 160))}`)
  assert.equal(unwrappedApc(thumbText), false, 'the SVG thumbnail batch was DCS-wrapped')

  // The tool card's inline raster is the enhancement this PR owns. Its own
  // width variant is a DIFFERENT cache entry, so a second raster call proves the
  // card and nothing else fed it (never a hand-built thumbnail).
  assert.equal(h.rasterCalls(), 1, 'the app rasterized exactly ONE variant for the card')
  const cardRows = (h.app as unknown as { messagesView: { render(w: number): string[] } })
    .messagesView.render(100)
  assert.ok(cardRows.join('\n').includes(PLACEHOLDER),
    `the app's own SVG card row carries the placeholder grid:\n${cardRows.slice(0, 8).join('\n')}`)
})

test('the SVG thumbnail paints through the managed handle and reports its REAL body', async (t) => {
  const h = product(t)
  assert.ok(h.graphics)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
    + '<rect width="64" height="32" fill="#3b82f6"/></svg>'
  const svgLoader = new SvgRasterLoader(async () => ({
    png: SAMPLE_PNG,
    base64: SAMPLE_PNG.toString('base64'),
    widthPx: 64,
    heightPx: 32,
  }))
  const thumbnail = new SvgThumbnail('svg-digest', svg, 320, svgLoader, {
    fallbackColor: (text: string) => text,
  }, () => {}, undefined, h.graphics)
  try {
    // The raster settles asynchronously and the component repaints on its own
    // notification; the loop plays the screens' repaint role.
    let body: { rows: number; endCol: number } | undefined
    let painted: string[] = []
    for (let attempt = 0; attempt < 400; attempt += 1) {
      painted = thumbnail.render(80)
      body = thumbnail.paintedImageBody(80)
      if (body !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.ok(body !== undefined, 'the SVG thumbnail reported a real painted body')
    assert.ok(painted.join('\n').includes(PLACEHOLDER),
      `the SVG thumbnail painted through the managed handle: ${JSON.stringify(painted.join('\n').slice(0, 120))}`)
    assert.ok(body.rows >= 1 && body.endCol >= 1)
  } finally {
    thumbnail.dispose()
    svgLoader.dispose()
  }
})

test('a REAL Assistant publication feeds the SAME app raster loader, Viewer Preview/Source and Copy', async (t) => {
  // The SVG Viewer's View/Copy affordances exist ONLY on the Assistant
  // publication path (`visualFigureOptions` → `openSvgViewer` / `copyVisualPayload`),
  // so this case drives that path: a real assistant row with the durable
  // `[dsh-visual-…]` markers, the PR2 publication sidecar, then the figure's own
  // View action and Copy Source through the app's real clipboard owner.
  const h = product(t, { sink: 'virtual' })
  assert.ok(h.graphics)
  const vt = h.terminal as SinkTerminal & { flush(): Promise<void>; getViewport(): string[] }
  const settleFrames = async (): Promise<void> => {
    await settle(h.app)
    await vt.flush()
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
    + '<rect width="64" height="32" fill="#3b82f6"/></svg>'
  const ref = 'assistant-svg'
  const source = {
    ref,
    type: 'svg' as const,
    title: 'Service topology',
    turn: 1,
    step: 0,
    stepStartSeq: 10,
    callSeq: 11,
    resultSeq: 12,
    callId: 'call-svg',
    chart: undefined,
    svg: {
      version: 1,
      type: 'svg' as const,
      title: 'Service topology',
      description: 'Gateway -> App',
      digest: createHash('sha256').update(svg, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(svg, 'utf8'),
    },
    svgSource: svg,
    svgAdmissionWidth: 640,
  }
  const publication = {
    ref,
    turn: 1,
    step: 0,
    stepStartSeq: 20,
    callSeq: 21,
    resultSeq: 22,
    callId: 'present-svg',
    source,
  }
  const message = {
    kind: 'assistant',
    turn: 1,
    text: `Service topology\n\n[dsh-visual-${ref}]: <#>`,
  } as never
  setAssistantVisualPresentation(message, {
    subjectKind: 'main',
    subjectId: 'session-1',
    sourceIdentity: {},
    session: {},
    sessionId: 'session-1',
    seq: 1,
    turn: 1,
    step: 0,
    text: (message as unknown as { text: string }).text,
    content: undefined,
    assistantRevision: 0,
  }, [publication as never])

  h.terminal.writes.length = 0
  ;(h.app as unknown as { setTranscript(messages: unknown[]): void }).setTranscript([message])
  await until(() => (h.rasterCalls() ?? 0) >= 1, 'the app rasterized the published SVG')
  await settleFrames()
  const cardText = h.terminal.writes.join('')
  assert.ok(cardText.length > 0, 'the published figure painted a frame')
  assert.ok(cardText.includes(PLACEHOLDER),
    `the published figure's thumbnail painted through the managed handle: ${JSON.stringify(cardText.slice(0, 160))}`)

  const handles = [...(h.app as unknown as {
    visualFigureHandles: Map<unknown, Map<string, unknown>>
  }).visualFigureHandles.values()].flatMap(byRef => [...byRef.values()])
  assert.equal(handles.length, 1, 'the app published exactly ONE visual handle for the row')
  const callsBeforeViewer = h.rasterCalls()

  // The figure's OWN View action (the production handler on the handle).
  h.terminal.writes.length = 0
  ;(h.app as unknown as { openSvgViewer(handle: unknown): void }).openSvgViewer(handles[0])
  await settleFrames()
  const viewerText = h.terminal.writes.join('')
  assert.ok(viewerText.length > 0, 'opening the SVG Viewer painted a frame')
  assert.ok(viewerText.includes(PLACEHOLDER), 'the Viewer painted its OWN width variant')
  assert.equal(unwrappedApc(viewerText), false, 'the Viewer batch was DCS-wrapped')
  assert.ok((h.rasterCalls() ?? 0) > callsBeforeViewer,
    'the Viewer derived a DIFFERENT width variant from the same shared loader')

  // The SOURCE page through the real Tab chord: the raw XML must be VISIBLE and
  // the placeholder grid must be gone from the painted frame.
  const beforeSource = h.rasterCalls() ?? 0
  vt.sendInput('\t')
  await settleFrames()
  const sourceView = vt.getViewport().join('\n')
  assert.ok(sourceView.includes('<svg') && sourceView.includes('<rect'),
    `the Source page shows the raw SVG text:\n${sourceView}`)
  assert.equal(sourceView.includes(PLACEHOLDER), false,
    `the Source page paints NO placeholder cells:\n${sourceView}`)
  assert.equal(h.rasterCalls(), beforeSource, 'the Source page starts no new raster work')

  // Back to PREVIEW through the same chord: pixels return from the SAME cache.
  vt.sendInput('\t')
  await settleFrames()
  const previewAgain = vt.getViewport().join('\n')
  assert.equal(previewAgain.includes('<rect'), false, `the Preview page hides the source:\n${previewAgain}`)

  // Copy Source goes through the app's real clipboard owner.
  const clipboard: string[] = []
  const runs: string[] = []
  ;(h.app as unknown as { copySelection?: unknown }).copySelection = (text: string): Promise<boolean> => {
    clipboard.push(text)
    return Promise.resolve(true)
  }
  ;(h.app as unknown as { events: { runOwned?: (label: string, task: () => Promise<boolean>) => void } })
    .events.runOwned = (label, task) => {
      runs.push(label)
      void task()
    }
  ;(h.app as unknown as { handleInput(data: string): void }).handleInput('c')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(clipboard, [svg], 'the RAW SVG reached the real clipboard sink')
  assert.ok(runs.some(label => label.includes('visual copy')), `the copy ran as an owned task: ${runs.join(',')}`)

  // Esc leaves the leased screen and the published figure returns.
  h.terminal.writes.length = 0
  vt.sendInput('\x1b')
  await settleFrames()
  const restored = vt.getViewport().join('\n')
  assert.ok(restored.includes('Service topology'),
    `the published figure returned to the transcript:\n${restored}`)
})

test('a REAL SVG tool message is authorized and thumbnailed by the app\'s OWN raster loader', async (t) => {
  // Evidence scope, stated precisely: a durable TOOL MESSAGE (the way the Host
  // delivers it) goes through the app's own card renderer, which authorizes the
  // SVG and mounts an inline raster produced by the ONE `SvgRasterLoader` the
  // app was constructed with.
  //
  // This case does NOT open the SVG Viewer and does NOT copy: a tool-card SVG
  // exposes the inline raster only, while the View/Copy affordances belong to
  // the Assistant PUBLICATION path (`visualFigureHandles` → `openSvgViewer` /
  // `copyVisualPayload`). The Viewer's own Preview/Source/Copy/resize contract is
  // covered by `test/client/svg-viewer.test.ts`.
  const h = product(t, { sink: 'virtual' })
  assert.ok(h.graphics)
  const vt = h.terminal as SinkTerminal & { flush(): Promise<void>; getViewport(): string[] }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
    + '<rect width="64" height="32" fill="#3b82f6"/></svg>'

  const svgFact = {
    version: 1,
    type: 'svg',
    title: 'Service topology',
    description: 'Gateway -> App',
    digest: createHash('sha256').update(svg, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(svg, 'utf8'),
  }
  // The EXACT row shape the Host produces for an SVG tool call: `result` is the
  // durable human text and the LAST block is the machine credential.
  const svgFactWithVersion = {
    version: 1 as const,
    type: 'svg' as const,
    title: 'Service topology',
    description: 'Gateway -> App',
    digest: svgFact.digest,
    bytes: svgFact.bytes,
  }
  const human = svgHumanText(svgFactWithVersion)
  const toolMessage = {
    kind: 'tool',
    turn: 1,
    name: SVG_TOOL_NAME,
    args: JSON.stringify({ title: 'Service topology', description: 'Gateway -> App', svg }),
    result: human,
    resultBlocks: [
      { type: 'text', text: human },
      { type: 'text', text: `visual-v1:${JSON.stringify(svgFactWithVersion)}` },
    ],
    status: 'ok',
  } as never
  h.terminal.writes.length = 0
  const appInternal = h.app as unknown as {
    setTranscript(messages: unknown[]): void
    messages: readonly unknown[]
    toggleMessageExpanded(message: unknown): void
    requestRender(): void
  }
  appInternal.setTranscript([toolMessage])
  // Expand the card through the app's OWN disclosure owner: the SVG body (and
  // its inline raster) is part of the expanded card.
  appInternal.toggleMessageExpanded(appInternal.messages[0])
  // The thumbnail is an ASYNC raster: wait for the injected loader to settle.
  await settle(h.app)
  await vt.flush()
  await until(() => {
    ;(h.app as unknown as { requestRender(): void }).requestRender()
    return (h.rasterCalls() ?? 0) >= 1
  }, 'the app rasterized the SVG through its own loader')
  await settle(h.app)
  await vt.flush()
  const thumbText = h.terminal.writes.join('')
  assert.ok(thumbText.length > 0, 'the SVG card painted a frame')
  assert.ok(thumbText.includes(PLACEHOLDER),
    `the app's own SVG thumbnail painted through the managed handle: ${JSON.stringify(thumbText.slice(0, 160))}`)
  assert.equal(unwrappedApc(thumbText), false, 'the SVG thumbnail batch was DCS-wrapped')

  // The tool card's inline raster is the enhancement this PR owns. Its own
  // width variant is a DIFFERENT cache entry, so a second raster call proves the
  // card and nothing else fed it (never a hand-built thumbnail).
  assert.equal(h.rasterCalls(), 1, 'the app rasterized exactly ONE variant for the card')
  const cardRows = (h.app as unknown as { messagesView: { render(w: number): string[] } })
    .messagesView.render(100)
  assert.ok(cardRows.join('\n').includes(PLACEHOLDER),
    `the app's own SVG card row carries the placeholder grid:\n${cardRows.slice(0, 8).join('\n')}`)
})

test('the SVG thumbnail paints through the managed handle and reports its REAL body', async (t) => {
  const h = product(t)
  assert.ok(h.graphics)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
    + '<rect width="64" height="32" fill="#3b82f6"/></svg>'
  const svgLoader = new SvgRasterLoader(async () => ({
    png: SAMPLE_PNG,
    base64: SAMPLE_PNG.toString('base64'),
    widthPx: 64,
    heightPx: 32,
  }))
  const thumbnail = new SvgThumbnail('svg-digest', svg, 320, svgLoader, {
    fallbackColor: (text: string) => text,
  }, () => {}, undefined, h.graphics)
  try {
    // The raster settles asynchronously and the component repaints on its own
    // notification; the loop plays the screens' repaint role.
    let body: { rows: number; endCol: number } | undefined
    let painted: string[] = []
    for (let attempt = 0; attempt < 400; attempt += 1) {
      painted = thumbnail.render(80)
      body = thumbnail.paintedImageBody(80)
      if (body !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.ok(body !== undefined, 'the SVG thumbnail reported a real painted body')
    assert.ok(painted.join('\n').includes(PLACEHOLDER),
      `the SVG thumbnail painted through the managed handle: ${JSON.stringify(painted.join('\n').slice(0, 120))}`)
    assert.ok(body.rows >= 1 && body.endCol >= 1)
  } finally {
    thumbnail.dispose()
    svgLoader.dispose()
  }
})

test('a REAL Assistant publication feeds the SAME app raster loader, Viewer Preview/Source and Copy', async (t) => {
  // The SVG Viewer's View/Copy affordances exist ONLY on the Assistant
  // publication path (`visualFigureOptions` → `openSvgViewer` / `copyVisualPayload`),
  // so this case drives that path: a real assistant row with the durable
  // `[dsh-visual-…]` markers, the PR2 publication sidecar, then the figure's own
  // View action and Copy Source through the app's real clipboard owner.
  const h = product(t, { sink: 'virtual' })
  assert.ok(h.graphics)
  const vt = h.terminal as SinkTerminal & { flush(): Promise<void>; getViewport(): string[] }
  const settleFrames = async (): Promise<void> => {
    await settle(h.app)
    await vt.flush()
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
    + '<rect width="64" height="32" fill="#3b82f6"/></svg>'
  const ref = 'assistant-svg'
  const source = {
    ref,
    type: 'svg' as const,
    title: 'Service topology',
    turn: 1,
    step: 0,
    stepStartSeq: 10,
    callSeq: 11,
    resultSeq: 12,
    callId: 'call-svg',
    chart: undefined,
    svg: {
      version: 1,
      type: 'svg' as const,
      title: 'Service topology',
      description: 'Gateway -> App',
      digest: createHash('sha256').update(svg, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(svg, 'utf8'),
    },
    svgSource: svg,
    svgAdmissionWidth: 640,
  }
  const publication = {
    ref,
    turn: 1,
    step: 0,
    stepStartSeq: 20,
    callSeq: 21,
    resultSeq: 22,
    callId: 'present-svg',
    source,
  }
  const message = {
    kind: 'assistant',
    turn: 1,
    text: `Service topology\n\n[dsh-visual-${ref}]: <#>`,
  } as never
  setAssistantVisualPresentation(message, {
    subjectKind: 'main',
    subjectId: 'session-1',
    sourceIdentity: {},
    session: {},
    sessionId: 'session-1',
    seq: 1,
    turn: 1,
    step: 0,
    text: (message as unknown as { text: string }).text,
    content: undefined,
    assistantRevision: 0,
  }, [publication as never])

  h.terminal.writes.length = 0
  ;(h.app as unknown as { setTranscript(messages: unknown[]): void }).setTranscript([message])
  await until(() => (h.rasterCalls() ?? 0) >= 1, 'the app rasterized the published SVG')
  await settleFrames()
  const cardText = h.terminal.writes.join('')
  assert.ok(cardText.length > 0, 'the published figure painted a frame')
  assert.ok(cardText.includes(PLACEHOLDER),
    `the published figure's thumbnail painted through the managed handle: ${JSON.stringify(cardText.slice(0, 160))}`)

  const handles = [...(h.app as unknown as {
    visualFigureHandles: Map<unknown, Map<string, unknown>>
  }).visualFigureHandles.values()].flatMap(byRef => [...byRef.values()])
  assert.equal(handles.length, 1, 'the app published exactly ONE visual handle for the row')
  const callsBeforeViewer = h.rasterCalls()

  // The figure's OWN View action (the production handler on the handle).
  h.terminal.writes.length = 0
  ;(h.app as unknown as { openSvgViewer(handle: unknown): void }).openSvgViewer(handles[0])
  await settleFrames()
  const viewerText = h.terminal.writes.join('')
  assert.ok(viewerText.length > 0, 'opening the SVG Viewer painted a frame')
  assert.ok(viewerText.includes(PLACEHOLDER), 'the Viewer painted its OWN width variant')
  assert.equal(unwrappedApc(viewerText), false, 'the Viewer batch was DCS-wrapped')
  assert.ok((h.rasterCalls() ?? 0) > callsBeforeViewer,
    'the Viewer derived a DIFFERENT width variant from the same shared loader')

  // Copy Source through the app's real clipboard owner.
  const clipboard: string[] = []
  const runs: string[] = []
  ;(h.app as unknown as { copySelection?: unknown }).copySelection = (text: string): Promise<boolean> => {
    clipboard.push(text)
    return Promise.resolve(true)
  }
  ;(h.app as unknown as { events: { runOwned?: (label: string, task: () => Promise<boolean>) => void } })
    .events.runOwned = (label, task) => {
      runs.push(label)
      void task()
    }
  ;(h.app as unknown as { handleInput(data: string): void }).handleInput('c')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(clipboard, [svg], 'the RAW SVG reached the real clipboard sink')
  assert.ok(runs.some(label => label.includes('visual copy')), `the copy ran as an owned task: ${runs.join(',')}`)
})

test('a malformed SVG tool message is refused by the app and paints text only', async (t) => {
  // The app's OWN `authorizeSvg` gate decides this: the credential matches the
  // call source, but the source is not admissible XML, so the card keeps its
  // readable description and paints NO pixels and NO raster work.
  const h = product(t, { sink: 'virtual' })
  assert.ok(h.graphics)
  const badSource = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10"'
  const fact = {
    version: 1 as const,
    type: 'svg' as const,
    title: 'Broken drawing',
    description: 'unparseable',
    digest: createHash('sha256').update(badSource, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(badSource, 'utf8'),
  }
  const human = svgHumanText(fact)
  const message = {
    kind: 'tool',
    turn: 1,
    name: SVG_TOOL_NAME,
    args: JSON.stringify({ title: fact.title, description: fact.description, svg: badSource }),
    result: human,
    resultBlocks: [
      { type: 'text', text: human },
      { type: 'text', text: `visual-v1:${JSON.stringify(fact)}` },
    ],
    status: 'ok',
  } as never
  h.terminal.writes.length = 0
  const appInternal = h.app as unknown as {
    setTranscript(messages: unknown[]): void
    messages: readonly unknown[]
    toggleMessageExpanded(message: unknown): void
  }
  appInternal.setTranscript([message])
  appInternal.toggleMessageExpanded(appInternal.messages[0])
  await settle(h.app)
  await new Promise(resolve => setTimeout(resolve, 300))

  const written = h.terminal.writes.join('')
  assert.ok(written.length > 0, 'the refused card really painted a frame')
  assert.equal(written.includes(PLACEHOLDER), false, 'no placeholder cell was painted')
  assert.equal(transmissions(written).length, 0, 'no managed transmission was offered')
  assert.equal(h.rasterCalls(), 0, 'the refused SVG started NO raster work')
  const rows = (h.app as unknown as { messagesView: { render(w: number): string[] } })
    .messagesView.render(100)
  const painted = rows.join('\n')
  assert.ok(painted.includes('Broken drawing') || painted.includes('Drawing unavailable'),
    `the card keeps a truthful text presentation:\n${painted.slice(0, 400)}`)
})
