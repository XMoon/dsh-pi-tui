/**
 * Image-7C-3 — the real Zellij product composition (E2), generalized by
 * Image-7C from Ghostty-host-only to every host whose live pane answers OK.
 *
 * The cases build the ONE production `TuiApp` over a real `ProcessTerminal`
 * substitute (`VirtualTerminal` as the physical sink), let the fork's own
 * `detectCapabilities()` classify the REAL process environment, and drive the
 * production Zellij factory through its live `a=q` handshake. The only
 * stand-in is the terminal itself and the test-fed Zellij answer; every image
 * consumer below is the production class.
 *
 * PRODUCTION PREREQUISITES REPRODUCED:
 *   real TuiApp construction; actual fork getCapabilities; createNative ??
 *   createZellij ?? createTmux; Terminal.start callback; native facade/Core;
 *   real Screen and media consumers; image read/convert counter; deterministic
 *   observable physical terminal bytes.
 * TEST STAND-INS:
 *   VirtualTerminal for physical tty; test-fed Zellij a=q response; disposable
 *   media files.
 * DELIBERATELY ABSENT:
 *   real Zellij server/host attachment, Ghostty GUI pixels, OS mouse/keyboard
 *   delivery; these belong ONLY to the E3 matrix.
 * @module @xmoon76/dsh-pi-tui/integration/kitty-zellij-screen.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test, { afterEach } from 'node:test'
import {
  getCapabilities,
  resetCapabilitiesCache,
  setCapabilityOverrides,
} from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { ImageCache } from '../../src/client/media/image/cache.ts'
import { convertKittyThumbnail } from '../../src/client/media/image/kitty-thumbnail.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import { setAssistantVisualPresentation } from '../../src/domain/visual/presentation.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'
import { effectiveImageProtocol } from '../../src/tui/graphics/image-capability.ts'
import { parseKittyApc } from '../../src/tui/graphics/kitty-native.ts'
import { ZELLIJ_PROBE_TIMEOUT_MS } from '../../src/tui/graphics/zellij-image.ts'
import type { KittyGraphics } from '../../src/tui/graphics/native-image.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'

const SAMPLE_PNG = readFileSync(new URL('../fixtures/images/transcript-sample.png', import.meta.url))
const SAMPLE_JPEG = readFileSync(new URL('../fixtures/images/transcript-sample.jpg', import.meta.url))
const SAMPLE_WEBP = readFileSync(new URL('../fixtures/images/transcript-sample.webp', import.meta.url))
const PLACEHOLDER = '\u{10EEEE}'
function probeReply(vt: VirtualTerminal, payload = 'OK'): string {
  const match = /a=q,i=(\d+)/.exec(vt.writes.join(''))
  assert.ok(match, 'the real TuiApp sent a probe query')
  return `\x1b_Gi=${match[1]};${payload}\x1b\\`
}

const ENV_KEYS = [
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'GHOSTTY_RESOURCES_DIR',
  'KITTY_WINDOW_ID',
  'ITERM_SESSION_ID',
  'TMUX',
  'TMUX_PANE',
  'ZELLIJ',
  'ZELLIJ_SESSION_NAME',
  'STY',
  'WEZTERM_PANE',
  'WARP_SESSION_ID',
  'WARP_TERMINAL_SESSION_UUID',
  'PI_IMAGE_PROTOCOL',
  'PI_TUI_TMUX_KITTY_IMAGES',
  'WT_SESSION',
] as const

/** Apply exactly one real environment through the real detection path. */
function applyEnvironment(environment: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>()
  for (const key of ENV_KEYS) {
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

function zellijEnvironment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    TERM: 'xterm-ghostty',
    TERM_PROGRAM: 'ghostty',
    ZELLIJ: '0',
    ZELLIJ_SESSION_NAME: 'zellij-itest',
    PI_TUI_TMUX_KITTY_IMAGES: '0',
    ...overrides,
  }
}

interface MediaCounter {
  readonly loader: ImageLoader
  readonly reads: Map<string, number>
  readonly conversions: () => number
}

function countingLoader(): MediaCounter {
  let conversions = 0
  const reads = new Map<string, number>()
  const dataFor = (mediaType: string): Buffer => {
    if (mediaType === 'image/jpeg') return SAMPLE_JPEG
    if (mediaType === 'image/webp') return SAMPLE_WEBP
    return SAMPLE_PNG
  }
  const loader = new ImageLoader(
    async (ref) => {
      reads.set(ref.attachmentId, (reads.get(ref.attachmentId) ?? 0) + 1)
      return { ref: {}, data: dataFor(ref.mediaType) }
    },
    new ImageCache(),
    async (input, mediaType) => {
      conversions += 1
      return convertKittyThumbnail(input, mediaType)
    },
  )
  return { loader, reads, conversions: () => conversions }
}

interface ProductHarness {
  readonly terminal: VirtualTerminal
  readonly app: TuiApp
  readonly graphics: KittyGraphics
  readonly loader: ImageLoader
  readonly reads: Map<string, number>
  readonly conversions: () => number
  readonly store: DraftImageStore
  readonly rasterCalls: () => number
}

/** Build the REAL product composition on the real environment. */
function product(t: { after(fn: () => void): void }, environment = zellijEnvironment()): ProductHarness {
  const restore = applyEnvironment(environment)
  t.after(restore)
  const media = countingLoader()
  const store = new DraftImageStore()
  let rasterCalls = 0
  const svgLoader = new SvgRasterLoader(async () => {
    rasterCalls += 1
    return { png: SAMPLE_PNG, base64: SAMPLE_PNG.toString('base64'), widthPx: 120, heightPx: 80 }
  })
  const terminal = new VirtualTerminal(120, 60)
  const app = new TuiApp(terminal, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: media.loader,
    imageTheme: { fallbackColor: (text: string) => text },
    draftImagePreviewSource: { values: () => store.values() },
    draftImagePreviewLiveDraft: read => store.setLiveDraftTextSource(read),
    draftImagePreviewReserve: text => store.pinReferenced(text),
    draftImagePreviewUndo: {
      registerUndoOwner: (owner, retireDraftImage) => store.registerUndoOwner(owner, retireDraftImage),
      releaseUndoForOwner: owner => store.releaseUndoForOwner(owner),
      reconcileUndoOwner: (owner, placeholders) => store.reconcileUndoOwner(owner, placeholders),
    },
    svgRasterLoader: svgLoader,
  })
  app.start()
  const graphics = (app as unknown as { graphics: KittyGraphics | undefined }).graphics
  assert.ok(graphics, 'the real Zellij environment must create the managed handle')
  return {
    terminal,
    app,
    graphics,
    loader: media.loader,
    reads: media.reads,
    conversions: media.conversions,
    store,
    rasterCalls: () => rasterCalls,
  }
}

const apps = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  apps.disposeAll()
})

function started(harness: ProductHarness): ProductHarness {
  apps.started.add(harness.app)
  return harness
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

async function settle(app: TuiApp, vt: VirtualTerminal): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    app.requestRender()
    await new Promise(resolve => setTimeout(resolve, 15))
    await vt.waitForRender()
  }
}

function apcs(text: string): NonNullable<ReturnType<typeof parseKittyApc>>[] {
  const found: NonNullable<ReturnType<typeof parseKittyApc>>[] = []
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

function imageRef(attachmentId: string, name: string, mediaType: ImageAttachmentRefLike['mediaType']): ImageAttachmentRefLike {
  const bytes = mediaType === 'image/jpeg' ? SAMPLE_JPEG : mediaType === 'image/webp' ? SAMPLE_WEBP : SAMPLE_PNG
  return { attachmentId, mediaType, bytes: bytes.byteLength, width: 120, height: 80, name }
}

function userMessage(content: unknown[], seq: number): never {
  return { type: 'user/message', seq, time: seq, data: { content, source: { kind: 'user' } } } as never
}

function transcriptOf(ref: ImageAttachmentRefLike): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.apply([userMessage([{ type: 'image', attachment: ref }], 1)])
  return folder
}

function hasManagedWire(text: string): boolean {
  return text.includes('a=t,f=100') && text.includes('a=p,')
}

test('the real TuiApp stays text-only until the live OK, then paints one Native PNG handle', async (t) => {
  const h = started(product(t))
  const vt = h.terminal
  try {
    assert.equal(getCapabilities().images, 'kitty', 'the fork really classified the detected Ghostty host')
    assert.equal(h.graphics.mode, 'zellij-negotiated')
    assert.equal(h.graphics.canPaint(), false, 'probing starts text-only')
    assert.equal(effectiveImageProtocol(h.graphics), null)
    assert.equal((h.app as unknown as { terminal: unknown }).terminal, h.graphics.terminal,
      'the ONE facade is the terminal both screens write through')
    const query = (vt.writes.join('').match(/a=q,i=\d+/g) ?? []).length
    assert.equal(query, 1, 'exactly one live-pane query after the real input listener was installed')

    const ref = imageRef('att-zellij-png', 'zellij.png', 'image/png')
    h.app.setTranscript(transcriptOf(ref).messages())
    h.app.requestRender()
    await vt.waitForRender()
    assert.equal(h.reads.get(ref.attachmentId), undefined, 'no payload byte is read while the probe is pending')
    assert.equal(h.conversions(), 0, 'no conversion while the probe is pending')
    assert.equal(vt.writes.join('').includes('a=t,f=100'), false, 'no managed upload before admission')
    assert.equal(vt.writes.join('').includes('a=T,'), false, 'no legacy image fallback before admission')
    const pendingView = vt.getScrollBuffer().join('\n')
    assert.ok(pendingView.includes('🖼️ zellij.png'), `the text identity row is painted:\n${pendingView}`)

    vt.sendInput(probeReply(vt))
    await until(() => h.graphics.canPaint(), 'the live OK admission')
    await until(() => h.reads.get(ref.attachmentId) === 1, 'the real PNG read after admission')
    await settle(h.app, vt)
    assert.equal(effectiveImageProtocol(h.graphics), 'kitty', 'the admitted handle paints kitty')
    assert.equal(h.conversions(), 0, 'a PNG needs no derived conversion')
    const wire = vt.writes.join('')
    const commands = apcs(wire)
    const uploads = commands.filter(entry => entry.controls.a === 't')
    const placements = commands.filter(entry => entry.controls.a === 'p')
    assert.equal(uploads.length, 1, 'one managed upload for the one occurrence')
    assert.equal(placements.length, 1, 'one managed placement')
    assert.ok(wire.indexOf('a=t,f=100') < wire.indexOf('a=p,'), 'a=t precedes a=p')
    assert.equal(placements[0]!.controls.i, uploads[0]!.controls.i)
    assert.equal(placements[0]!.controls.q, '2')
    assert.equal(placements[0]!.controls.C, '1')
    assert.equal(wire.includes('a=T,'), false, 'no legacy combined form')
    assert.equal(wire.includes('\x1bPtmux;'), false, 'no tmux DCS')
    assert.equal(wire.includes(PLACEHOLDER), false, 'no virtual placeholder')
    assert.equal(wire.includes('d=A') || wire.includes('d=a'), false, 'no global image delete')
    const view = vt.getScrollBuffer().join('\n')
    assert.ok(view.includes('🖼️ zellij.png'), `the identity row survived the upgrade:\n${view}`)
    assert.ok(view.includes('120×80 · 258 B'), `the real attachment facts paint:\n${view}`)

    // Main → Alt → Main keeps the SAME handle and the SAME image id.
    h.app.setFullscreen(true)
    await settle(h.app, vt)
    assert.equal((h.app as unknown as { graphics: unknown }).graphics, h.graphics, 'fullscreen keeps the one handle')
    const internals = h.app as unknown as {
      mountedImageOccurrences(): { thumbnail: { paintedImageBody(width: number): { rows: number; endCol: number } | undefined } }[]
      transcriptRenderWidth(): number
    }
    const body = internals.mountedImageOccurrences()[0]?.thumbnail.paintedImageBody(internals.transcriptRenderWidth())
    assert.ok(body !== undefined, 'the fullscreen occurrence has a real clickable body')
    const rows = await vt.flushAndGetViewport()
    const infoRow = rows.findIndex(row => row.includes('120×80 · 258 B'))
    assert.ok(infoRow >= 0, `the fullscreen info row is painted:\n${rows.join('\n')}`)
    const clickColumn = Math.max(1, Math.min(4, body.endCol))
    vt.sendInput(`\x1b[<0;${clickColumn};${infoRow + 2}M`)
    vt.sendInput(`\x1b[<0;${clickColumn};${infoRow + 2}m`)
    await settle(h.app, vt)
    assert.ok(vt.getViewport().join('\n').includes('Image · zellij.png'), 'the Viewer opened from the real body')
    vt.sendInput('\x1b')
    await settle(h.app, vt)
    assert.ok(vt.getViewport().join('\n').includes('🖼️ zellij.png'), 'Esc restored the transcript')
    h.app.setFullscreen(false)
    await settle(h.app, vt)
    assert.equal((h.app as unknown as { graphics: unknown }).graphics, h.graphics, 'return keeps the one handle')
  } finally {
    h.app.dispose()
    apps.started.delete(h.app)
  }
})

test('JPEG and WebP transcript images read once each and convert through the live handle', async (t) => {
  const h = started(product(t))
  const vt = h.terminal
  try {
    vt.sendInput(probeReply(vt))
    await until(() => h.graphics.canPaint(), 'the live OK admission')
    for (const [mediaType, id, name] of [
      ['image/jpeg', 'att-zellij-jpeg', 'jpeg.jpg'],
      ['image/webp', 'att-zellij-webp', 'webp.webp'],
    ] as const) {
      const ref = imageRef(id, name, mediaType)
      vt.writes.length = 0
      h.app.setTranscript(transcriptOf(ref).messages())
      await until(() => h.reads.get(id) === 1, `the ${mediaType} read`)
      await settle(h.app, vt)
      const wire = vt.writes.join('')
      assert.ok(hasManagedWire(wire), `${mediaType} painted through the managed handle`)
      assert.equal(wire.includes('a=T,'), false, `${mediaType} never used the legacy form`)
      assert.equal(vt.getScrollBuffer().join('\n').includes(`🖼️ ${name}`), true)

      h.app.setFullscreen(true)
      await settle(h.app, vt)
      const internals = h.app as unknown as {
        mountedImageOccurrences(): { thumbnail: { paintedImageBody(width: number): { rows: number; endCol: number } | undefined } }[]
        transcriptRenderWidth(): number
      }
      const body = internals.mountedImageOccurrences()[0]?.thumbnail.paintedImageBody(internals.transcriptRenderWidth())
      assert.ok(body !== undefined, `${mediaType}: the fullscreen thumbnail has a real body`)
      const rows = vt.getViewport()
      const infoRow = rows.findIndex(row => row.includes('120×80') && row.includes(name))
      assert.ok(infoRow >= 0, `${mediaType}: the fullscreen identity row is painted:\n${rows.join('\n')}`)
      const clickColumn = Math.max(1, Math.min(4, body.endCol))
      vt.sendInput(`\x1b[<0;${clickColumn};${infoRow + 2}M`)
      vt.sendInput(`\x1b[<0;${clickColumn};${infoRow + 2}m`)
      await settle(h.app, vt)
      assert.ok(vt.getViewport().join('\n').includes(`Image · ${name}`), `${mediaType}: the Viewer opened`)
      vt.sendInput('\x1b')
      await settle(h.app, vt)
      assert.ok(vt.getViewport().join('\n').includes(`🖼️ ${name}`), `${mediaType}: Esc restored the transcript`)
      h.app.setFullscreen(false)
      await settle(h.app, vt)
    }
    assert.equal(h.conversions(), 2, 'one derived conversion per JPEG/WebP occurrence')
  } finally {
    h.app.dispose()
    apps.started.delete(h.app)
  }
})

test('the draft preview paints through the live handle and undo restores the image', async (t) => {
  const h = started(product(t))
  const vt = h.terminal
  try {
    vt.sendInput(probeReply(vt))
    await until(() => h.graphics.canPaint(), 'the live OK admission')
    const image = h.store.add({
      bytes: SAMPLE_PNG,
      mediaType: 'image/png',
      width: 120,
      height: 80,
      name: 'draft.png',
    })
    h.app.setDraft(image.placeholder)
    await settle(h.app, vt)
    const draftWire = vt.writes.join('')
    assert.ok(hasManagedWire(draftWire), 'the draft card painted real pixels through the same handle')
    assert.equal(h.reads.size, 0, 'the draft card never touched the durable loader')

    h.app.setFullscreen(true)
    await settle(h.app, vt)
    const rows = await vt.flushAndGetViewport()
    const identityRow = rows.findIndex(row => row.includes('#1/1 · 120×80'))
    assert.ok(identityRow >= 0, `the draft identity row is painted:\n${rows.join('\n')}`)
    // The x control sits on the far-right cell of the identity row.
    vt.sendInput(`\x1b[<0;120;${identityRow + 1}M`)
    vt.sendInput(`\x1b[<0;120;${identityRow + 1}m`)
    await settle(h.app, vt)
    assert.equal(h.app.getDraft(), '', 'the x control removed the image placeholder')
    assert.equal(h.store.size(), 1, 'the removed draft is retained for undo')
    vt.sendInput('\x1b[45;5u')
    await settle(h.app, vt)
    assert.ok(h.app.getDraft().includes(image.placeholder), 'Undo restored the canonical placeholder')
    assert.ok(vt.getViewport().join('\n').includes('#1/1 · 120×80'), 'the preview came back')
    h.app.setFullscreen(false)
    await settle(h.app, vt)
  } finally {
    h.app.dispose()
    apps.started.delete(h.app)
  }
})

test('a published SVG uses the app raster loader for Preview and paints raw text for Source', async (t) => {
  const h = started(product(t))
  const vt = h.terminal
  try {
    vt.sendInput(probeReply(vt))
    await until(() => h.graphics.canPaint(), 'the live OK admission')
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
    h.app.setTranscript([message])
    await until(() => h.rasterCalls() >= 1, 'the app rasterized the published SVG')
    await settle(h.app, vt)
    assert.ok(hasManagedWire(vt.writes.join('')), 'the published thumbnail painted through the live handle')

    const handles = [...(h.app as unknown as {
      visualFigureHandles: Map<unknown, Map<string, unknown>>
    }).visualFigureHandles.values()].flatMap(byRef => [...byRef.values()])
    assert.equal(handles.length, 1, 'exactly one published visual handle')
    vt.writes.length = 0
    const beforeViewer = h.rasterCalls()
    ;(h.app as unknown as { openSvgViewer(handle: unknown): void }).openSvgViewer(handles[0])
    await settle(h.app, vt)
    const viewerWire = vt.writes.join('')
    const viewerApcs = apcs(viewerWire)
    assert.ok(viewerApcs.some(entry => entry.controls.a === 'p'),
      'the SVG Preview painted its OWN placement in the Viewer-only wire segment')
    assert.equal(viewerWire.includes('a=T,'), false, 'the SVG Viewer never used the legacy form')
    assert.ok(h.rasterCalls() > beforeViewer, 'the Viewer derived its own width variant')

    vt.writes.length = 0
    vt.sendInput('\t')
    await settle(h.app, vt)
    const sourceWire = vt.writes.join('')
    const sourceView = vt.getViewport().join('\n')
    assert.ok(sourceView.includes('<svg') && sourceView.includes('<rect'), `the Source page shows raw SVG:\n${sourceView}`)
    assert.equal(sourceView.includes(PLACEHOLDER), false, 'the Source page paints no image cells')
    const sourceImageCommands = apcs(sourceWire).filter(entry =>
      entry.controls.a === 't' || entry.controls.a === 'p' || entry.controls.a === 'T')
    assert.deepEqual(sourceImageCommands, [],
      'the Source-only wire segment carries no image transmission or placement APC')
    assert.equal(sourceWire.includes('a=T,'), false, 'the Source page never used the legacy image form')
    const beforeSource = h.rasterCalls()
    vt.sendInput('\t')
    await settle(h.app, vt)
    assert.equal(h.rasterCalls(), beforeSource, 'returning to Preview reuses the cached raster')
    vt.sendInput('\x1b')
    await settle(h.app, vt)
    assert.ok(vt.getViewport().join('\n').includes('Service topology'), 'Esc restored the transcript')
  } finally {
    h.app.dispose()
    apps.started.delete(h.app)
  }
})

test('the live handle keeps one id through bare 2J/3J, scopes deletes and recovers a failed write', async (t) => {
  const h = started(product(t))
  const vt = h.terminal
  try {
    vt.sendInput(probeReply(vt))
    await until(() => h.graphics.canPaint(), 'the live OK admission')
    h.app.stop()
    const graphics = h.graphics
    const component = graphics.image(
      { pngBase64: SAMPLE_PNG.toString('base64'), widthPx: 120, heightPx: 80 },
      { maxWidthCells: 40, maxHeightCells: 10, fallback: '[image]' },
    )
    const lines = component.render(100)
    vt.writes.length = 0
    graphics.terminal.write(lines.join('\n'))
    const first = apcs(vt.writes.join(''))
    const imageId = first.find(entry => entry.controls.a === 't')!.controls.i!
    assert.equal(first.filter(entry => entry.controls.a === 't').length, 1)

    // Same-id redraw: the cached occurrence re-places without a new upload.
    vt.writes.length = 0
    graphics.terminal.write(lines.join('\n'))
    assert.equal(apcs(vt.writes.join('')).filter(entry => entry.controls.a === 't').length, 0)
    assert.equal(apcs(vt.writes.join('')).filter(entry => entry.controls.a === 'p').length, 1)

    for (const clear of ['\x1b[2J', '\x1b[3J']) {
      vt.writes.length = 0
      graphics.terminal.write(clear)
      graphics.terminal.write(lines.join('\n'))
      const segment = vt.writes.join('')
      const upload = segment.indexOf('a=t,f=100')
      const placement = segment.indexOf('a=p,')
      assert.ok(upload !== -1, `${JSON.stringify(clear)} invalidated the resident payload`)
      assert.ok(upload < placement, `${JSON.stringify(clear)}: re-transmission precedes placement`)
      assert.equal(apcs(segment).find(entry => entry.controls.a === 't')!.controls.i, imageId, 'same id re-used')
    }

    // Foreign id: byte-identical pass-through; an own writer delete: scoped
    // placement removal, never a data free and never a global form.
    vt.writes.length = 0
    graphics.terminal.write('\x1b_Ga=d,d=I,i=4294967295,q=2\x1b\\')
    assert.equal(vt.writes.join(''), '\x1b_Ga=d,d=I,i=4294967295,q=2\x1b\\')
    vt.writes.length = 0
    graphics.terminal.write(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`)
    const ownDelete = vt.writes.join('')
    assert.ok(ownDelete.includes(`d=i,i=${imageId}`), 'the writer delete became a scoped placement removal')
    assert.equal(ownDelete.includes('d=I'), false, 'the Core never frees terminal-retained data on a writer delete')
    assert.equal(ownDelete.includes('d=A') || ownDelete.includes('d=a'), false, 'no global delete')
    assert.equal(ownDelete.includes('4294967295'), false, 'the foreign id is never mentioned')

    const second = graphics.image(
      { pngBase64: SAMPLE_PNG.toString('base64'), widthPx: 120, heightPx: 80 },
      { maxWidthCells: 40, maxHeightCells: 10, fallback: '[second]' },
    )
    graphics.terminal.write(second.render(100).join('\n'))
    vt.writes.length = 0
    graphics.terminal.write('\x1b_Ga=d,d=A\x1b\\')
    const globalTranslated = vt.writes.join('')
    assert.equal(globalTranslated.includes('d=A'), false, 'a global delete never reaches the terminal')
    assert.ok(globalTranslated.includes('d=I,i='), 'it becomes scoped own-id operations')

    // A failed write must be offered again with a transmission before placement.
    const third = graphics.image(
      { pngBase64: SAMPLE_PNG.toString('base64'), widthPx: 120, heightPx: 80 },
      { maxWidthCells: 40, maxHeightCells: 10, fallback: '[third]' },
    )
    const thirdLines = third.render(100)
    const originalWrite = vt.write.bind(vt)
    let failed = false
    vt.write = (data: string): void => {
      originalWrite(data)
      if (!failed && data.includes('a=p,')) {
        failed = true
        throw new Error('terminal write failed')
      }
    }
    assert.throws(() => graphics.terminal.write(thirdLines.join('\n')), /terminal write failed/)
    vt.write = originalWrite
    vt.writes.length = 0
    graphics.terminal.write(thirdLines.join('\n'))
    const recovered = vt.writes.join('')
    assert.ok(recovered.indexOf('a=t,f=100') !== -1 && recovered.indexOf('a=t,f=100') < recovered.indexOf('a=p,'),
      'the failed sink never leaves residency acknowledged')

    graphics.dispose()
    const afterDispose = graphics.image(
      { pngBase64: SAMPLE_PNG.toString('base64'), widthPx: 120, heightPx: 80 },
      { maxWidthCells: 40, maxHeightCells: 10, fallback: '[after-dispose]' },
    )
    vt.writes.length = 0
    assert.deepEqual(afterDispose.render(100), ['[after-dispose]'], 'a disposed Core never registers')
    graphics.terminal.write(afterDispose.render(100).join('\n'))
    assert.equal(vt.writes.join('').includes('a=t'), false, 'no late upload after dispose')
  } finally {
    h.app.dispose()
    apps.started.delete(h.app)
  }
})

test('every Zellij host and static capability class gets one live query, then paints after its actual OK', async (t) => {
  const cases: ReadonlyArray<{ name: string; environment: Record<string, string | undefined> }> = [
    { name: 'WezTerm-host Zellij', environment: zellijEnvironment({ TERM_PROGRAM: 'wezterm', WEZTERM_PANE: '4' }) },
    { name: 'Kitty-host Zellij, ZELLIJ=1', environment: zellijEnvironment({ TERM_PROGRAM: 'kitty', ZELLIJ: '1' }) },
    { name: 'Warp-host Zellij', environment: zellijEnvironment({ TERM_PROGRAM: 'warpterminal', WARP_SESSION_ID: 'warp-1' }) },
    { name: 'Tern-host Zellij', environment: zellijEnvironment({ TERM_PROGRAM: 'tern' }) },
    { name: 'unknown host, fork images=null', environment: zellijEnvironment({ TERM_PROGRAM: undefined, TERM: 'xterm-256color' }) },
    { name: 'iTerm2 host, fork images=iterm2', environment: zellijEnvironment({ TERM_PROGRAM: 'iterm.app', TERM: 'xterm-256color', ITERM_SESSION_ID: 'iterm-1' }) },
    { name: 'missing session name', environment: zellijEnvironment({ ZELLIJ_SESSION_NAME: undefined }) },
  ]
  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async (st) => {
      const h = started(product(st, entry.environment))
      const vt = h.terminal
      try {
        assert.equal((vt.writes.join('').match(/a=q,i=\d+/g) ?? []).length, 1,
          `${entry.name}: exactly one live query after the real input listener`)
        assert.equal(h.graphics.canPaint(), false, `${entry.name}: probing starts text-only`)
        const ref = imageRef(`att-zellij-host-${index}`, 'host.png', 'image/png')
        h.app.setTranscript(transcriptOf(ref).messages())
        h.app.requestRender()
        await vt.waitForRender()
        assert.equal(h.reads.get(ref.attachmentId), undefined, `${entry.name}: no payload byte before the OK`)
        assert.equal(h.conversions(), 0, `${entry.name}: no conversion before the OK`)
        assert.equal(vt.writes.join('').includes('a=t,f=100'), false, `${entry.name}: no upload before the OK`)

        vt.sendInput(probeReply(vt))
        await until(() => h.graphics.canPaint(), `${entry.name}: the live OK admission`)
        await until(() => h.reads.get(ref.attachmentId) === 1, `${entry.name}: the real read after admission`)
        await settle(h.app, vt)
        const wire = vt.writes.join('')
        assert.ok(hasManagedWire(wire), `${entry.name}: the managed transmission and placement reached the screen`)
        assert.equal(wire.includes('a=T,'), false, `${entry.name}: no legacy combined form`)
        assert.equal(wire.includes('\x1b]1337;File='), false, `${entry.name}: no iTerm2 image sequence`)
        assert.equal(wire.includes('\x1bPtmux;'), false, `${entry.name}: no tmux DCS`)
        assert.equal(wire.includes(PLACEHOLDER), false, `${entry.name}: no virtual placeholder`)
      } finally {
        h.app.dispose()
        apps.started.delete(h.app)
      }
    })
  }
})

test('a Zellij live OK keeps Main and Alt managed when the fork capability is null or iterm2', async (t) => {
  const cases = [
    {
      name: 'fork images=null',
      environment: zellijEnvironment({ TERM_PROGRAM: undefined, TERM: 'xterm-256color' }),
      capability: null,
    },
    {
      name: 'fork images=iterm2',
      environment: zellijEnvironment({ TERM_PROGRAM: 'iterm.app', TERM: 'xterm-256color', ITERM_SESSION_ID: 'iterm-2' }),
      capability: 'iterm2',
    },
  ] as const
  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const h = started(product(st, entry.environment))
      const vt = h.terminal
      try {
        assert.equal(getCapabilities().images, entry.capability, `${entry.name}: the fork capability fact`)
        vt.sendInput(probeReply(vt))
        await until(() => h.graphics.canPaint(), `${entry.name}: the live OK admission`)
        const ref = imageRef(`att-zellij-main-alt-${entry.name}`, 'main-alt.png', 'image/png')
        h.app.setTranscript(transcriptOf(ref).messages())
        await until(() => h.reads.get(ref.attachmentId) === 1, `${entry.name}: the real read`)
        await settle(h.app, vt)
        const mainWire = vt.writes.join('')
        assert.ok(hasManagedWire(mainWire), `${entry.name}: Main paints the managed image`)
        assert.equal(mainWire.includes('\x1b]1337;File='), false, `${entry.name}: no iTerm2 image on Main`)

        vt.writes.length = 0
        h.app.setFullscreen(true)
        await settle(h.app, vt)
        const altWire = vt.writes.join('')
        assert.ok(hasManagedWire(altWire), `${entry.name}: Alt re-transmits and re-places through the managed facade`)
        assert.equal(altWire.includes('\x1b]1337;File='), false, `${entry.name}: no iTerm2 image on Alt`)
        assert.equal(altWire.includes('d=A') || altWire.includes('d=a'), false, `${entry.name}: no global image delete`)
        assert.equal(altWire.includes(PLACEHOLDER), false, `${entry.name}: no virtual placeholder`)

        vt.writes.length = 0
        h.app.setFullscreen(false)
        await settle(h.app, vt)
        assert.ok(hasManagedWire(vt.writes.join('')), `${entry.name}: Main restores the image after the Alt switch`)
        assert.equal(vt.writes.join('').includes('\x1b]1337;File='), false, `${entry.name}: no iTerm2 fallback after the switch`)

        for (const cycle of [1, 2] as const) {
          vt.writes.length = 0
          h.app.setFullscreen(true)
          await settle(h.app, vt)
          assert.ok(hasManagedWire(vt.writes.join('')), `${entry.name}: Alt entry ${cycle} repaints the managed image`)
          assert.equal(vt.writes.join('').includes('d=A'), false, `${entry.name}: Alt entry ${cycle} has no global delete`)
          assert.equal((h.app as unknown as { graphics: unknown }).graphics, h.graphics,
            `${entry.name}: Alt entry ${cycle} keeps the ONE graphics handle`)
          vt.writes.length = 0
          h.app.setFullscreen(false)
          await settle(h.app, vt)
        }
      } finally {
        h.app.dispose()
        apps.started.delete(h.app)
      }
    })
  }
})

test('a delayed Zellij OK pre-arms the Alt cleanup protocol and releases only own placements', async (t) => {
  const cases = [
    {
      name: 'fork images=null',
      environment: zellijEnvironment({ TERM_PROGRAM: undefined, TERM: 'xterm-256color' }),
      capability: null,
    },
    {
      name: 'fork images=iterm2',
      environment: zellijEnvironment({ TERM_PROGRAM: 'iterm.app', TERM: 'xterm-256color', ITERM_SESSION_ID: 'iterm-3' }),
      capability: 'iterm2',
    },
  ] as const
  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const h = started(product(st, entry.environment))
      const vt = h.terminal
      try {
        const reply = probeReply(vt)
        h.app.setFullscreen(true)
        assert.equal(h.graphics.canPaint(), false, `${entry.name}: the Alt screen starts before the live answer`)

        const ref = imageRef(`att-zellij-delayed-${entry.name}`, 'delayed.png', 'image/png')
        h.app.setTranscript(transcriptOf(ref).messages())
        h.app.requestRender()
        await vt.waitForRender()
        assert.equal(h.reads.get(ref.attachmentId), undefined, `${entry.name}: pending Alt never reads a payload`)
        assert.equal(vt.writes.join('').includes('a=t,f=100'), false, `${entry.name}: pending Alt emits no image`)

        vt.sendInput(reply)
        await until(() => h.graphics.canPaint(), `${entry.name}: the delayed live OK admission`)
        await until(() => h.reads.get(ref.attachmentId) === 1, `${entry.name}: the real read after admission`)
        await settle(h.app, vt)
        const shown = vt.writes.join('')
        assert.ok(hasManagedWire(shown), `${entry.name}: the admitted Alt paints the managed image`)
        const shownImageId = apcs(shown).filter(entry => entry.controls.a === 'p').at(-1)?.controls.i
        assert.ok(shownImageId, `${entry.name}: the Alt placement names an image id`)

        vt.writes.length = 0
        h.app.setTranscript([])
        await settle(h.app, vt)
        const removal = vt.writes.join('')
        assert.ok(removal.includes(`a=d,d=i,i=${shownImageId}`), `${entry.name}: Alt removal removes the own placement`)
        assert.equal(/a=d,d=A|a=d,d=a/.test(removal), false, `${entry.name}: Alt removal never sends a global delete`)
        assert.equal(removal.includes('\x1b[2J'), false, `${entry.name}: Alt removal never uses the iTerm2 clear`)
        for (const command of apcs(removal)) {
          if (command.controls.a === 'd') assert.equal(command.controls.i, shownImageId, `${entry.name}: no foreign delete`)
        }

        const secondRef = imageRef(`att-zellij-delayed-${entry.name}-2`, 'delayed-2.png', 'image/png')
        vt.writes.length = 0
        h.app.setTranscript(transcriptOf(secondRef).messages())
        await settle(h.app, vt)
        const restoredImageId = apcs(vt.writes.join('')).filter(entry => entry.controls.a === 'p').at(-1)?.controls.i
        assert.ok(restoredImageId, `${entry.name}: the Alt re-place names an image id`)

        vt.writes.length = 0
        h.app.setFullscreen(false)
        await settle(h.app, vt)
        const stop = vt.writes.join('')
        assert.ok(stop.includes(`a=d,d=I,i=${restoredImageId}`), `${entry.name}: Alt stop releases the own managed id`)
        assert.equal(/a=d,d=A|a=d,d=a/.test(stop), false, `${entry.name}: Alt stop never sends a global delete`)
        assert.equal(getCapabilities().images, entry.capability, `${entry.name}: the static capability is restored`)
      } finally {
        h.app.dispose()
        apps.started.delete(h.app)
      }
    })
  }
})

test('a denied Zellij live query inside Alt stays payload-free and emits no image work', async (t) => {
  const h = started(product(t, zellijEnvironment({ TERM_PROGRAM: undefined, TERM: 'xterm-256color' })))
  const vt = h.terminal
  try {
    const reply = probeReply(vt)
    h.app.setFullscreen(true)
    await settle(h.app, vt)
    const ref = imageRef('att-zellij-denied-alt', 'denied.png', 'image/png')
    vt.writes.length = 0
    h.app.setTranscript(transcriptOf(ref).messages())
    await settle(h.app, vt)
    assert.equal(h.reads.get(ref.attachmentId), undefined, 'a pending Alt never reads')
    vt.sendInput(`\x1b_Gi=${reply.match(/i=(\d+)/)?.[1]};ENOTSUPPORTED:disabled\x1b\\`)
    await new Promise(resolve => setTimeout(resolve, 30))
    await settle(h.app, vt)
    assert.equal(h.graphics.canPaint(), false, 'the live rejection is permanent')
    const wire = vt.writes.join('')
    assert.equal(h.reads.get(ref.attachmentId), undefined, 'no read after the live rejection')
    assert.equal(wire.includes('a=t,f=100') || wire.includes('a=p,'), false, 'no managed image after the live rejection')
    assert.equal(wire.includes('a=T,'), false, 'no legacy image after the live rejection')
    assert.equal(/a=d,d=A|a=d,d=a/.test(wire), false, 'no global delete after the live rejection')
  } finally {
    h.app.dispose()
    apps.started.delete(h.app)
  }
})

test('explicit Zellij hard-off and nested multiplexers stay text-only and never use a legacy image path', async (t) => {
  const cases: ReadonlyArray<{ name: string; environment: Record<string, string | undefined> }> = [
    { name: 'ZELLIJ empty', environment: zellijEnvironment({ ZELLIJ: '', TERM_PROGRAM: undefined, TERM: 'xterm-256color' }) },
    { name: 'tmux nested', environment: zellijEnvironment({ TMUX: '/tmp/tmux,1,0' }) },
    { name: 'screen nested', environment: zellijEnvironment({ STY: 'screen-1' }) },
    { name: 'PI_IMAGE_PROTOCOL=none', environment: zellijEnvironment({ PI_IMAGE_PROTOCOL: 'none' }) },
    { name: 'PI_IMAGE_PROTOCOL=0', environment: zellijEnvironment({ PI_IMAGE_PROTOCOL: '0' }) },
    {
      name: 'PI_IMAGE_PROTOCOL=iterm2',
      environment: zellijEnvironment({ PI_IMAGE_PROTOCOL: 'iterm2' }),
    },
  ]
  for (const [index, entry] of cases.entries()) {
    const restore = applyEnvironment(entry.environment)
    try {
      const media = countingLoader()
      const terminal = new VirtualTerminal(100, 40)
      const app = new TuiApp(terminal, { onSubmit: () => {}, onExit: () => {} }, {
        imageLoader: media.loader,
        imageTheme: { fallbackColor: (text: string) => text },
      })
      app.start()
      apps.started.add(app)
      try {
        // The 'ZELLIJ empty' case is NOT a Zellij session (an empty marker is not
        // a session): it is a Direct terminal, so Image-8 / I8-2A may create its
        // one SIXEL candidate there. Such a candidate is `pending` and may paint
        // nothing until the terminal's own DA1 admits it, so the contract this
        // case proves is "no MANIPULABLE handle", not "no object at all".
        const handle = (app as unknown as { graphics: KittyGraphics | { mode: string; canPaint(): boolean } | undefined }).graphics
        if (handle !== undefined) {
          assert.equal((handle as { mode: string }).mode, 'sixel', `${entry.name}: only a Direct SIXEL candidate may exist`)
          assert.equal(handle.canPaint(), false, `${entry.name}: and it may paint nothing`)
        }
        const ref = imageRef(`att-negative-${index}`, 'rejected.png', 'image/png')
        app.setTranscript(transcriptOf(ref).messages())
        await settle(app, terminal)
        const wire = terminal.writes.join('')
        assert.equal(/a=q,i=\d+/.test(wire), false, `${entry.name}: no probe may run`)
        assert.equal(media.reads.get(ref.attachmentId), undefined, `${entry.name}: no payload read`)
        assert.equal(media.conversions(), 0, `${entry.name}: no conversion`)
        assert.equal(wire.includes('a=t,f=100') || wire.includes('a=p,') || wire.includes('a=T,'),
          false, `${entry.name}: no managed or legacy image command`)
        assert.equal(wire.includes('\x1b]1337;File='), false, `${entry.name}: no iTerm2 fallback`)
        assert.equal(wire.includes('\x1bPtmux;'), false, `${entry.name}: no DCS fallback`)
        assert.equal(wire.includes(PLACEHOLDER), false, `${entry.name}: no virtual placeholder`)
        assert.ok(terminal.getScrollBuffer().join('\n').includes('🖼️ rejected.png'),
          `${entry.name}: the text identity row is still painted`)
        terminal.sendInput('a')
        await settle(app, terminal)
        assert.ok(app.getDraft().includes('a'), `${entry.name}: keyboard input still reaches the editor`)
      } finally {
        app.dispose()
        apps.started.delete(app)
      }
    } finally {
      restore()
    }
  }
})


test('a silent Zellij pane times out to text-only in the real TuiApp', async (t) => {
  const h = started(product(t))
  const vt = h.terminal
  try {
    assert.equal(h.graphics.canPaint(), false)
    const ref = imageRef('att-timeout', 'timeout.png', 'image/png')
    h.app.setTranscript(transcriptOf(ref).messages())
    h.app.requestRender()
    await vt.waitForRender()
    assert.equal(h.reads.size, 0, 'the pending frame never reads')
    // The contract IS the 500 ms probe window.
    await new Promise(resolve => setTimeout(resolve, ZELLIJ_PROBE_TIMEOUT_MS + 60))
    assert.equal(h.graphics.canPaint(), false, 'no live answer leaves the pane denied')
    await settle(h.app, vt)
    const wire = vt.writes.join('')
    assert.equal(h.reads.size, 0, 'the timeout never reads a payload')
    assert.equal(h.conversions(), 0, 'the timeout never converts')
    assert.equal(wire.includes('a=t,f=100') || wire.includes('a=p,'), false, 'the timeout emits no managed image')
    assert.equal(wire.includes('a=T,'), false, 'the timeout never uses the legacy form')
  } finally {
    h.app.dispose()
    apps.started.delete(h.app)
  }
})

test('an ENOTSUPPORTED reply leaves the real TuiApp text-only with no read or managed APC', async (t) => {
  const h = started(product(t))
  const vt = h.terminal
  try {
    vt.sendInput(probeReply(vt, 'ENOTSUPPORTED:disabled'))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(h.graphics.canPaint(), false, 'the live rejection is permanent')
    const ref = imageRef('att-rejected', 'rejected.png', 'image/png')
    h.app.setTranscript(transcriptOf(ref).messages())
    await settle(h.app, vt)
    const wire = vt.writes.join('')
    assert.equal(h.reads.size, 0, 'no read after the live rejection')
    assert.equal(h.conversions(), 0, 'no conversion after the live rejection')
    assert.equal(wire.includes('a=t,f=100') || wire.includes('a=p,'), false, 'no managed image after rejection')
    assert.equal(wire.includes('a=T,'), false, 'no legacy image after rejection')
    assert.ok(vt.getScrollBuffer().join('\n').includes('🖼️ rejected.png'))
  } finally {
    h.app.dispose()
    apps.started.delete(h.app)
  }
})

test('explicit PI_IMAGE_PROTOCOL=kitty overrides the strict WT auto filter in the real Zellij product', async (t) => {
  const h = started(product(t, zellijEnvironment({
    PI_IMAGE_PROTOCOL: 'kitty',
    TERM_PROGRAM: 'Windows_Terminal',
    TERM: 'xterm-256color',
    WT_SESSION: 'wt-session',
  })))
  const vt = h.terminal
  try {
    vt.sendInput(probeReply(vt))
    await until(() => (h.graphics as unknown as { selectedProtocol(): 'kitty' | 'sixel' | null }).selectedProtocol() === 'kitty',
      'the explicit Kitty selection')
    assert.equal(h.graphics.canPaint(), true)
    assert.equal(vt.writes.join('').includes('\x1bP0;1;q'), false, 'no SIXEL fallback')
  } finally {
    h.app.dispose()
    apps.started.delete(h.app)
  }
})
