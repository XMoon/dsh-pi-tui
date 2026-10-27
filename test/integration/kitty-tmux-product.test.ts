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
import { readFileSync } from 'node:fs'
import test, { afterEach, type TestContext } from 'node:test'
import { resetCapabilitiesCache, setCapabilities, type Terminal, type TerminalProgressState } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { ImageCache } from '../../src/client/media/image/cache.ts'
import { convertKittyThumbnail } from '../../src/client/media/image/kitty-thumbnail.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import { SvgThumbnail } from '../../src/tui/components/media/svg-thumbnail.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'
import { effectiveImageProtocol } from '../../src/tui/graphics/image-capability.ts'
import type { KittyGraphics } from '../../src/tui/graphics/native-image.ts'
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

interface ProductHarness {
  readonly cli: FakeTmuxCli
  readonly terminal: RecordingTerminal
  readonly app: TuiApp
  readonly graphics: KittyGraphics | undefined
  readonly loader: ImageLoader
  readonly store: DraftImageStore
  readonly reads: Map<string, number>
  readonly conversions: () => number
}

/** Build the REAL product composition on the scripted server. */
function product(t: TestContext, options: { optIn?: boolean } = {}): ProductHarness {
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
  const terminal = new RecordingTerminal()
  const svgLoader = new SvgRasterLoader(async () => ({
    png: Buffer.from(SAMPLE_PNG),
    base64: SAMPLE_PNG.toString('base64'),
    widthPx: 64,
    heightPx: 32,
  }))
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
  return { cli, terminal, app, graphics, loader, store, reads, conversions: () => conversionCount }
}

function userMessage(content: unknown[], seq: number): never {
  return { type: 'user/message', seq, time: seq, data: { content, source: { kind: 'user' } } } as never
}

function pngRef(attachmentId: string, name: string): ImageAttachmentRefLike {
  return {
    attachmentId,
    mediaType: 'image/png',
    bytes: SAMPLE_PNG.byteLength,
    width: 64,
    height: 64,
    name,
  }
}

test('the real composition root admits the tmux virtual handle where the fork detects no protocol', (t) => {
  const h = product(t)
  assert.ok(h.graphics, 'the production composition created a managed handle')
  assert.equal(h.graphics.mode, 'tmux-virtual', 'the tmux transport was selected')
  assert.equal(h.graphics.canPaint(), true, 'the live server admits exactly one Kitty client')
  assert.equal(effectiveImageProtocol(h.graphics), 'kitty', 'the product classifier admits this frame')
  assert.equal(h.app.terminal, h.graphics.terminal, 'the ONE facade is the terminal both screens write through')
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

  const painted = h.terminal.text
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

  const text = h.terminal.text
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
  assert.ok(h.terminal.text.includes(PLACEHOLDER), 'the admitted frame painted placeholders')
  const readsBefore = h.reads.get(ref.attachmentId)
  const conversionsBefore = h.conversions()

  // The real client binding changes on the SERVER side.
  h.cli.setReply('list-clients', { text: '' })
  h.terminal.writes.length = 0
  await settle(h.app)

  assert.equal(effectiveImageProtocol(h.graphics), null, 'the product classifier reports the revoked latch')
  assert.equal(h.graphics.canPaint(), false, 'the underlying admission stays revoked')
  const after = h.terminal.text
  assert.equal(transmissions(after).length, 0, 'no managed transmission escaped after revocation')
  assert.equal(placements(after).length, 0, 'no managed placement escaped after revocation')
  assert.equal(after.includes(PLACEHOLDER), false, 'no placeholder cell reached the sink after revocation')
  assert.equal(unwrappedApc(after), false, 'and nothing escaped unwrapped')
  assert.equal(h.reads.get(ref.attachmentId), readsBefore, 'the revoked surface re-read no payload')
  assert.equal(h.conversions(), conversionsBefore, 'the revoked surface ran no conversion')
  assert.ok(after.length > 0, 'a real text frame was still written')
})

test('the draft card paints through the SAME Core, and removal returns the band to text', async (t) => {
  const h = product(t)
  assert.ok(h.graphics)
  const draft = h.store.add({
    bytes: SAMPLE_PNG,
    mediaType: 'image/png',
    width: 64,
    height: 64,
    name: 'draft.png',
  })
  h.app.setDraft(draft.placeholder)
  await settle(h.app)

  const painted = h.terminal.text
  assert.equal(unwrappedApc(painted), false, 'the draft card travelled inside its DCS too')
  assert.ok(transmissions(painted).length >= 1, 'the draft card transmitted its PNG')
  assert.ok(painted.includes(PLACEHOLDER), 'the draft card painted the placeholder grid')
  assert.equal(h.reads.size, 0, 'the draft card never touched the DURABLE loader')

  // The `#id/total` identity row stays the text authority over the pixels.
  h.terminal.writes.length = 0
  h.app.setDraft('')
  await settle(h.app)
  const cleared = h.terminal.text
  assert.equal(cleared.includes(PLACEHOLDER), false, 'removing the token erased the grid')
  assert.equal(transmissions(cleared).length, 0, 'and transmitted nothing new')
})

test('the fullscreen Viewer reuses the transcript image and Esc restores the transcript', async (t) => {
  const h = product(t)
  assert.ok(h.graphics)
  const ref = pngRef('att-viewer', 'viewer.png')
  const folder = new TranscriptFolder()
  folder.apply([userMessage([{ type: 'image', attachment: ref }], 1)])
  h.app.setTranscript(folder.messages())
  await until(() => h.loader.get(ref).state === 'ready', 'the transcript PNG read')
  await settle(h.app)
  const transcriptIds = new Set([...h.terminal.text.matchAll(/i=(\d+)/g)].map(match => match[1]!))
  assert.ok(transcriptIds.size >= 1, 'the transcript painted one managed image')

  h.app.setFullscreen(true)
  await settle(h.app)
  h.terminal.writes.length = 0
  const internals = h.app as unknown as {
    mountedImageOccurrences(): unknown[]
    canLeaseImageWorkspace(): boolean
    openImageViewer(occurrence: unknown): void
  }
  const occurrences = internals.mountedImageOccurrences()
  assert.equal(occurrences.length, 1, 'fixture: one mounted occurrence')
  assert.equal(internals.canLeaseImageWorkspace(), true, 'fixture: the workspace lease is free')
  internals.openImageViewer(occurrences[0])
  await settle(h.app)

  const viewer = h.terminal.text
  assert.ok(viewer.includes(PLACEHOLDER), 'the Viewer painted real pixels')
  assert.equal(unwrappedApc(viewer), false, 'the Viewer batch was wrapped too')
  assert.equal(h.reads.get(ref.attachmentId), 1, 'the Viewer re-read no durable bytes')

  h.terminal.writes.length = 0
  // Esc is the Viewer's OWN close route (the workspace lease is released by the
  // host, not by the panel): drive the real key, never a private helper.
  ;(h.app as unknown as { handleInput(data: string): void }).handleInput('\x1b')
  await settle(h.app)
  const restored = h.terminal.text
  assert.equal(unwrappedApc(restored), false, 'the restored frame stayed wrapped')
  h.app.setFullscreen(false)
  await settle(h.app)
  assert.equal(h.reads.get(ref.attachmentId), 1, 'leaving the Viewer read nothing again')
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
