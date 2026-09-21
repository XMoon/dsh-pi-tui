/**
 * Regression tests for the fullscreen scroll geometry epoch (perf plan
 * §19 candidate 1, 2026-09-21): the paint-snapshot commit reuses the
 * committed row snapshot on frames that did not change transcript geometry,
 * and `fullscreenRowsDirty` is raised by every geometry-mutating path.
 *
 * Pinned contract (see docs/perf-baseline.md):
 * 1. pure fullscreen scroll frames never remeasure the row map;
 * 2. an async image settle (which invalidates a component WITHOUT a row-map
 *    writer) forces exactly the next painted frame to remeasure, after which
 *    reuse resumes;
 * 3. the press/release stale-frame fence keeps its semantics across scrolled
 *    repaints — identical geometry accepts, shifted geometry rejects.
 * @module @xmoon76/dsh-pi-tui/fullscreen-scroll-geometry-epoch.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { resetCapabilitiesCache, setCapabilities } from '@xmoon76/pi-tui'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { ImageLoader } from '../src/image/loader.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function pngBytes(): Buffer {
  const bytes = Buffer.alloc(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}

const IMAGE_REF = {
  attachmentId: 'att-1',
  mediaType: 'image/png',
  bytes: 33,
  width: 800,
  height: 100,
  name: 'shot.png',
}

/** Append `turns` plain user/assistant turns to the event list. */
function pushTurns(events: unknown[], count: number, firstSeq: number, firstTurn: number): number {
  let seq = firstSeq
  for (let offset = 0; offset < count; offset += 1) {
    const turn = firstTurn + offset
    events.push({ type: 'turn/start', seq: seq++, time: turn * 10, data: { turn } })
    events.push({
      type: 'user/message', seq: seq++, time: turn * 10 + 1, data: {
        content: [{ type: 'text', text: `prompt ${turn}` }], source: { kind: 'user' },
      },
    })
    events.push({
      type: 'assistant/message', seq: seq++, time: turn * 10 + 2, data: {
        turn, step: 0,
        message: { id: `m${turn}`, role: 'assistant', content: [{ type: 'text', text: `answer ${turn}\n\nsecond line ${turn}` }], source: { kind: 'assistant' } },
      },
    })
    events.push({ type: 'turn/end', seq: seq++, time: turn * 10 + 3, data: { turn, reason: { kind: 'completed' } } })
  }
  return seq
}

/** A transcript long enough to overflow the 24-row viewport, so wheel
 * scrolling actually moves the content. */
function scrollFixture(): TranscriptFolder {
  const folder = new TranscriptFolder()
  const events: unknown[] = []
  pushTurns(events, 12, 0, 0)
  folder.apply(events as never[])
  return folder
}

/** Image-attachment fixture: leading history, the image turn, the NEXT
 * marker message, and tail history — everything the scroll tests need to
 * overflow the viewport while keeping the image visible at follow-end. */
function imageFixture(leadingTurns: number, tailTurns: number): TranscriptFolder {
  const folder = new TranscriptFolder()
  const events: unknown[] = []
  let seq = pushTurns(events, leadingTurns, 0, 0)
  const turn = leadingTurns
  events.push({ type: 'turn/start', seq: seq++, time: turn * 10, data: { turn } })
  events.push({
    type: 'user/message', seq: seq++, time: turn * 10 + 1, data: { content: [
      { type: 'text', text: 'check' },
      { type: 'image', attachment: IMAGE_REF },
    ], source: { kind: 'user' } },
  })
  events.push({
    type: 'user/message', seq: seq++, time: turn * 10 + 2, data: { content: [
      { type: 'text', text: 'NEXT' },
    ], source: { kind: 'user' } },
  })
  events.push({ type: 'turn/end', seq: seq++, time: turn * 10 + 3, data: { turn, reason: { kind: 'completed' } } })
  pushTurns(events, tailTurns, seq, turn + 1)
  folder.apply(events as never[])
  return folder
}

function startApp(loader?: ImageLoader): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, loader === undefined ? {} : {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text) => text },
  })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

/** One settled SGR wheel event (button 64 = up, 65 = down) at cell (10,5). */
async function wheel(vt: VirtualTerminal, direction: 'up' | 'down'): Promise<void> {
  const button = direction === 'up' ? 64 : 65
  vt.sendInput(`\x1b[<${button};10;5M`)
  await viewport(vt)
}

/** The 1-based row of the first line containing the needle. */
async function rowOf(vt: VirtualTerminal, needle: string, label: string): Promise<number> {
  const view = await viewport(vt)
  const index = view.split('\n').findIndex(line => line.includes(needle))
  assert.ok(index !== -1, `${label}: ${JSON.stringify(needle)} missing:\n${view}`)
  return index + 1
}

test('pure fullscreen scrolling never remeasures the transcript row map', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript(scrollFixture().messages())
  // Two settled frames: the fullscreen swap paint and the follow-end paint
  // both consumed the initial dirty flag.
  await viewport(vt)
  await viewport(vt)
  app.resetSearchPresentationDiagnosticsForTest()

  const topBefore = (await viewport(vt)).split('\n')
  for (let i = 0; i < 3; i += 1) await wheel(vt, 'up')
  for (let i = 0; i < 2; i += 1) await wheel(vt, 'down')
  const topAfter = (await viewport(vt)).split('\n')

  // The test itself must have scrolled: the viewport content must have moved.
  assert.notDeepEqual(topBefore, topAfter, 'the wheel input must scroll the transcript')
  const { remeasures } = app.searchPresentationDiagnosticsForTest()
  assert.equal(remeasures, 0, 'pure scroll frames must reuse the committed row snapshot (geometry epoch), not remeasure')
  app.setFullscreen(false)
  app.stop()
})

test('an async image settle forces a remeasure on the next painted frame, then reuse resumes', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  // The loader read is gated: the thumbnail stays UNSETTLED until released,
  // so the settle lands between two paints instead of during setup.
  let release!: () => void
  const gated = new Promise<void>(resolve => { release = resolve })
  const loader = new ImageLoader(async () => {
    await gated
    return { ref: {}, data: pngBytes() }
  })
  const { vt, app } = startApp(loader)
  app.setFullscreen(true)
  app.setTranscript(imageFixture(6, 2).messages())
  await viewport(vt)
  await viewport(vt)
  // Follow-end pins the tail, so the settled image's growth shows as a
  // WIDER gap between the info bar and NEXT, not as NEXT moving down.
  const gapOf = async (label: string): Promise<number> => {
    const view = (await viewport(vt)).split('\n')
    const info = view.findIndex(line => line.includes('🖼️ shot.png · 800×100'))
    const next = view.findIndex(line => line.includes('NEXT'))
    assert.ok(info !== -1 && next !== -1, `${label}: image info bar and NEXT must be visible`)
    return next - info
  }
  const gapBeforeSettle = await gapOf('pending')

  app.resetSearchPresentationDiagnosticsForTest()
  release()
  const gapAfterSettle = await gapOf('settled')
  assert.ok(gapAfterSettle > gapBeforeSettle, `the settled image must expand the layout (gap ${gapAfterSettle} > ${gapBeforeSettle})`)
  const { remeasures } = app.searchPresentationDiagnosticsForTest()
  assert.ok(remeasures >= 1, 'the settle must raise the epoch so the next painted frame remeasures')

  // Reuse must resume afterwards: scrolled repaints stay remeasure-free.
  app.resetSearchPresentationDiagnosticsForTest()
  await wheel(vt, 'up')
  await wheel(vt, 'up')
  await wheel(vt, 'down')
  assert.equal(app.searchPresentationDiagnosticsForTest().remeasures, 0, 'scrolled repaints after the settle must reuse the snapshot again')
  app.setFullscreen(false)
  app.stop()
})

test('the press/release fence keeps its semantics across scrolled repaints', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = new ImageLoader(async () => ({ ref: {}, data: pngBytes() }))
  const { vt, app } = startApp(loader)
  app.setFullscreen(true)
  app.setTranscript(imageFixture(6, 2).messages())
  await viewport(vt)
  await viewport(vt)

  // Scroll-invariant collapse measure: the rendered distance between the
  // attachment info bar and the NEXT message. Scrolling shifts both rows
  // equally; only a collapse/expand changes the gap.
  const gap = async (label: string): Promise<number> => {
    const info = await rowOf(vt, '🖼️ shot.png · 800×100', `${label} info bar`)
    const next = await rowOf(vt, 'NEXT', `${label} NEXT`)
    return next - info
  }
  const expandedGap = await gap('expanded')
  assert.ok(expandedGap >= 3, `the expanded image must separate info bar and NEXT (gap ${expandedGap})`)

  // (a) press on the info bar → scroll away → release at the SAME cell: the
  // cell now shows shifted content, so the fence must REJECT the click and
  // the image must stay expanded.
  const pressRow = await rowOf(vt, '🖼️ shot.png · 800×100', 'press info bar')
  vt.sendInput(`\x1b[<0;4;${pressRow}M`)
  for (let i = 0; i < 3; i += 1) await wheel(vt, 'up')
  vt.sendInput(`\x1b[<0;4;${pressRow}m`)
  await viewport(vt)
  const rejectedGap = await gap('rejected')
  assert.equal(rejectedGap, expandedGap, 'a shifted release must be rejected by the fence — the image stays expanded')

  // Let the double-click detector settle before the next press.
  await new Promise(resolve => setTimeout(resolve, 600))
  await viewport(vt)

  // (c) press at the info bar's CURRENT cell → scroll away and back (the
  // geometry returns byte-identical) → release at the same cell: the fence
  // must ACCEPT — reused rows preserve press-time identities.
  const pressRow2 = await rowOf(vt, '🖼️ shot.png · 800×100', 'second press info bar')
  vt.sendInput(`\x1b[<0;4;${pressRow2}M`)
  for (let i = 0; i < 3; i += 1) await wheel(vt, 'up')
  for (let i = 0; i < 3; i += 1) await wheel(vt, 'down')
  vt.sendInput(`\x1b[<0;4;${pressRow2}m`)
  await new Promise(resolve => setTimeout(resolve, 600))
  await viewport(vt)
  const acceptedGap = await gap('accepted')
  assert.ok(acceptedGap < expandedGap, `the round-trip release must be accepted and collapse the image (gap ${acceptedGap} < ${expandedGap})`)
  app.setFullscreen(false)
  app.stop()
})

test('the scroll profiler never latches a frame window on a no-op boundary scroll', async () => {
  // The profiler reads the env at app construction: scope it to this test.
  process.env.DSH_TUI_SCROLL_PROFILE = '1'
  const emitted: string[] = []
  const originalConsoleError = console.error
  console.error = (message: unknown): void => { emitted.push(String(message)) }
  try {
    const { vt, app } = startApp()
    app.setFullscreen(true)
    app.setTranscript(scrollFixture().messages())
    await viewport(vt)
    await viewport(vt)
    // Jump to the top WITHOUT scrollBy: no profiler window may open.
    ;(app as unknown as { fullscreenScroll: { scrollTo(top: number): void } }).fullscreenScroll.scrollTo(0)
    await viewport(vt)

    // A wheel-up AT the top moves nothing and requests no repaint: it must
    // NOT latch a profiling window.
    vt.sendInput('\x1b[<64;10;5M')
    await viewport(vt)
    // An unrelated repaint must not inherit the latched window either.
    app.requestRender()
    await viewport(vt)
    const frames = (): number => emitted.filter(line => line.startsWith('scroll frame=')).length
    assert.equal(frames(), 0, `a no-op boundary scroll must not latch a profiler window (emitted ${frames()})`)

    // A real scroll emits exactly ONE frame, timed from THIS wheel.
    await wheel(vt, 'down')
    assert.equal(frames(), 1, `the moving wheel must emit exactly one scroll frame (got ${frames()})`)
    const latency = Number(/frame=([\d.]+)ms/.exec(emitted.find(line => line.startsWith('scroll frame='))!)?.[1])    assert.ok(Number.isFinite(latency) && latency >= 0 && latency < 200, `scroll latency must be timed from the moving wheel (got ${latency}ms)`)
    app.setFullscreen(false)
    app.stop()
  } finally {
    console.error = originalConsoleError
    delete process.env.DSH_TUI_SCROLL_PROFILE
  }
})
