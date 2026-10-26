/**
 * The PR2.5 PiTui published-visual interaction on the REAL TuiApp surface: the
 * fullscreen press/release owner resolves the figure's painted cells, the
 * leased image workspace hosts the SVG Viewer, and the three Host actions copy
 * the exact authorized payloads.
 *
 * Evidence level: a headless `VirtualTerminal` frame + SGR mouse press/release
 * driven through the alt screen's own `onCellPress`/`onCellClick`. It is NOT a
 * physical terminal and NOT the L6 official-Session composition (see
 * `test/app/visual-copy-display.test.ts` for the Direct `/copy` chain).
 * @module @xmoon76/dsh-pi-tui/client/visual-presentation-tui.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from '@xmoon76/pi-tui'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import type { ChartFact } from '../../src/domain/visual/chart.ts'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'
import {
  setAssistantVisualPresentation,
  type VisualPresentationKey,
} from '../../src/domain/visual/presentation.ts'
import { svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import { TranscriptFolder, type TranscriptMessage } from '../../src/transcript.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { VIEWER_BLOCKED_PARENT_ACTIONS } from '../../src/tui/keybindings/definitions.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { runOwned, type OwnedTaskOptions } from '../../src/runtime/process/tasks.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
  resetCapabilitiesCache()
})

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/>'
  + '<text x="4" y="20" font-size="12" fill="#ffffff">Gateway</text></svg>'

const REF_A = `sv1_${'a'.repeat(20)}`
const REF_B = `sv1_${'b'.repeat(20)}`

const CHART: ChartFact = {
  version: 1,
  type: 'chart',
  kind: 'bars',
  title: 'Request latency',
  unit: 'ms',
  series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
}

const CHART_B: ChartFact = {
  version: 1,
  type: 'chart',
  kind: 'spark',
  title: 'Second latency',
  unit: 'ms',
  series: [{ label: 'p50', value: 11 }],
}

function marker(ref: string): string {
  return `[dsh-visual-${ref}]: <#>`
}

function chartPublication(ref: string, chart: ChartFact): PublishedVisual {
  return {
    ref,
    turn: 0,
    step: 1,
    stepStartSeq: 5,
    callSeq: 6,
    resultSeq: 7,
    callId: `present-${ref.slice(-1)}`,
    source: {
      ref,
      type: 'chart',
      title: chart.title,
      turn: 0,
      step: 0,
      stepStartSeq: 1,
      callSeq: 2,
      resultSeq: 3,
      callId: `chart-${ref.slice(-1)}`,
      chart,
      svg: undefined,
      svgSource: undefined,
      svgAdmissionWidth: undefined,
    },
  }
}

function svgPublication(ref: string): PublishedVisual {
  const fact = svgFactFromArgs({ title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE })
  return {
    ref,
    turn: 0,
    step: 1,
    stepStartSeq: 5,
    callSeq: 6,
    resultSeq: 7,
    callId: 'present-svg',
    source: {
      ref,
      type: 'svg',
      title: fact.title,
      turn: 0,
      step: 0,
      stepStartSeq: 1,
      callSeq: 2,
      resultSeq: 3,
      callId: 'svg-source',
      chart: undefined,
      svg: fact,
      svgSource: SVG_SOURCE,
      svgAdmissionWidth: 64,
    },
  }
}

function key(): VisualPresentationKey {
  return {
    subjectKind: 'main',
    subjectId: 'session',
    sourceIdentity: {},
    session: {},
    sessionId: 'session',
    seq: 10,
    turn: 0,
    step: 1,
    text: '',
    content: undefined,
    assistantRevision: 0,
  }
}

function answerFolder(text: string, content?: readonly ContentBlock[]): {
  folder: TranscriptFolder
  assistant: Extract<TranscriptMessage, { kind: 'assistant' }>
} {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } } as unknown as SessionEvent,
    {
      type: 'assistant/message',
      seq: 1,
      time: 2,
      data: {
        turn: 0,
        step: 0,
        message: {
          id: MessageId('answer'),
          role: 'assistant',
          content: content ?? [{ type: 'text', text }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    } as unknown as SessionEvent,
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 0, reason: { kind: 'completed' } } } as unknown as SessionEvent,
  ]
  folder.apply(events)
  const assistant = folder.messages().find(
    (message): message is Extract<TranscriptMessage, { kind: 'assistant' }> => message.kind === 'assistant',
  )
  assert.ok(assistant !== undefined)
  return { folder, assistant }
}

interface Mounted {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly copied: string[]
}

const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })
const owned = <T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>): void => {
  runOwned(label, task, { ...options, diag })
}

function mountApp(options: {
  readonly svgLoader?: SvgRasterLoader
  readonly copy?: (text: string) => Promise<boolean>
} = {}): Mounted {
  const vt = new VirtualTerminal(100, 30)
  const copied: string[] = []
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, runOwned: owned }, {
    ...(options.svgLoader === undefined ? {} : { svgRasterLoader: options.svgLoader }),
    imageTheme: { fallbackColor: text => text },
    copySelection: async (text: string) => {
      copied.push(text)
      return options.copy === undefined ? true : await options.copy(text)
    },
  })
  app.start()
  startedApps.add(app)
  return { vt, app, copied }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

/** Let the async SVG raster settle and land its repaint (a real loader
 *  promise chain, no blind UI sleep). */
async function settledViewport(vt: VirtualTerminal): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    await vt.waitForRender()
  }
  return vt.getViewport().join('\n')
}

/** The 1-based terminal cell of the first occurrence of one ASCII label. */
function cellOf(view: string, needle: string): { readonly x: number; readonly y: number } {
  const lines = view.split('\n')
  for (const [index, line] of lines.entries()) {
    const at = line.indexOf(needle)
    if (at < 0) continue
    return { x: visibleWidth(line.slice(0, at)) + 1, y: index + 1 }
  }
  assert.fail(`missing ${needle}:\n${view}`)
}

async function clickCell(vt: VirtualTerminal, cell: { readonly x: number; readonly y: number }): Promise<void> {
  vt.sendInput(`\x1b[<0;${cell.x};${cell.y}M`)
  vt.sendInput(`\x1b[<0;${cell.x};${cell.y}m`)
  // The fork's DOUBLE_CLICK window is a real contract of this surface.
  await new Promise(resolve => setTimeout(resolve, 600))
  await vt.waitForRender()
}

function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/gu, '')
}

test('a fullscreen View click opens the leased SVG viewer; Tab/C/Esc round-trip leaves the transcript untouched', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const requests: number[] = []
  const loader = new SvgRasterLoader(async (_source, options) => {
    requests.push(options.targetWidth)
    return { png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: options.targetWidth, heightPx: 8 }
  })
  const { vt, app, copied } = mountApp({ svgLoader: loader })
  app.setFullscreen(true)
  const doc = `Before.\n\n${marker(REF_A)}\n\nAfter.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [svgPublication(REF_A)])
  app.setTranscript(folder.messages())
  const before = await settledViewport(vt)
  const baseline = app.transcriptPresentationDiagnosticsForTest()
  assert.ok(before.includes('Service topology'), `the SVG figure is mounted:\n${before}`)
  assert.ok(before.includes('Copy SVG') && before.includes('View'), before)
  const viewCell = cellOf(before, 'View')
  await clickCell(vt, viewCell)
  const viewer = await viewport(vt)
  assert.ok(viewer.includes('SVG · Service topology'), `the leased SVG viewer opened:\n${viewer}`)
  assert.ok(viewer.includes('[Preview]') && viewer.includes('Source'), 'one active page device is painted')
  assert.ok(stripSgr(viewer).includes('Esc close'))
  // The viewer requested the Viewer grant variant, never the 64px thumbnail one.
  assert.ok(requests.some(width => width > 64), `the viewer raster width is its own variant: ${requests.join(', ')}`)
  // The inactive Source page device is a REAL pointer cell in the leased
  // screen: pressing it switches pages exactly like Tab.
  const sourceCell = cellOf(viewer, 'Source')
  await clickCell(vt, sourceCell)
  const pointerSource = await viewport(vt)
  assert.ok(pointerSource.includes('[Source]'), `the page device click switched to Source:\n${pointerSource}`)
  // Tab toggles BACK to Preview; Tab again reaches the Source page with the
  // raw XML text visible (Tab is the only page switch).
  vt.sendInput('\t')
  await vt.waitForRender()
  vt.sendInput('\t')
  await vt.waitForRender()
  const source = await viewport(vt)
  assert.ok(source.includes('[Source]'), source)
  assert.ok(stripSgr(source).includes('Gateway'), 'the source body shows the admitted XML')
  // C copies the exact raw source through the injected Client clipboard sink.
  vt.sendInput('c')
  await vt.waitForRender()
  assert.deepEqual(copied, [SVG_SOURCE], 'the viewer copy is the raw admitted source')
  // Esc closes the viewer and restores the SAME transcript layout: every
  // original row keeps its physical position (the settled copy notice is the
  // one legitimate new gutter line, and it never moves the answer itself).
  vt.sendInput('\x1b')
  const restored = await viewport(vt)
  const rowOf = (text: string, needle: string): number =>
    text.split('\n').findIndex(line => line.includes(needle)) + 1
  for (const needle of ['Before.', 'Service topology', 'Gateway -> App -> Database', 'Copy SVG', 'After.']) {
    assert.equal(rowOf(restored, needle), rowOf(before, needle), `${needle} keeps its painted row`)
  }
  const diagnostics = app.transcriptPresentationDiagnosticsForTest()
  assert.equal(diagnostics.structuralCommits, baseline.structuralCommits, 'the viewer round trip never rebuilds the transcript')
  assert.equal(diagnostics.contentCommits, baseline.contentCommits, 'the viewer round trip never re-commits content')
  app.stop()
  loader.dispose()
})

test('a fullscreen Copy SVG click copies the exact authorized source once', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = new SvgRasterLoader(async (_source, options) => ({
    png: new Uint8Array(),
    base64: TINY_PNG_BASE64,
    widthPx: options.targetWidth,
    heightPx: 8,
  }))
  const { vt, app, copied } = mountApp({ svgLoader: loader })
  app.setFullscreen(true)
  const doc = `Before.\n\n${marker(REF_A)}\n\nAfter.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [svgPublication(REF_A)])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const before = await viewport(vt)
  await clickCell(vt, cellOf(before, 'Copy SVG'))
  assert.deepEqual(copied, [SVG_SOURCE], 'one click, one clipboard call, exact raw bytes')
  const after = await viewport(vt)
  assert.ok(after.includes('Copied visual') || after.includes('Copy sent'), `a settled copy is acknowledged:\n${after}`)
  app.stop()
  loader.dispose()
})

test('a chart Copy Data click copies the final ChartFact as pretty JSON, and Alt+O never opens a chart viewer', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const { vt, app, copied } = mountApp()
  app.setFullscreen(true)
  const doc = `Before.\n\n${marker(REF_A)}\n\nAfter.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A, CHART)])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const before = await viewport(vt)
  assert.ok(before.includes('42 ms') && before.includes('70 ms'), before)
  await clickCell(vt, cellOf(before, 'Copy Data'))
  assert.deepEqual(copied, [JSON.stringify(CHART, null, 2)], 'the chart payload is the final fact, not rendered glyphs')
  // Select the chart and ask for the viewer: the truthful answer is that a
  // chart has no viewer (never a second surface).
  vt.sendInput('\x1bv')
  await vt.waitForRender()
  assert.ok(stripSgr(await viewport(vt)).includes('Selected 1/1 · Request latency'))
  vt.sendInput('\x1bo')
  await vt.waitForRender()
  const after = await viewport(vt)
  assert.ok(after.includes('Chart has no viewer'), after)
  assert.equal(after.includes('SVG ·'), false, 'no viewer screen was leased for a chart')
  app.stop()
})

test('Alt+V cycles only the current published figures; Alt+C copies the selected one', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const { vt, app, copied } = mountApp()
  app.setFullscreen(true)
  const doc = `Charts.\n\n${marker(REF_A)}\n\n${marker(REF_B)}\n\nEnd.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [
    chartPublication(REF_B, CHART_B),
    chartPublication(REF_A, CHART),
  ])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = await viewport(vt)
  assert.ok(view.includes('Request latency') && view.includes('Second latency'), view)
  // The publication order is durable (REF_B then REF_A), not marker order.
  vt.sendInput('\x1bv')
  await vt.waitForRender()
  const firstSelected = stripSgr(await viewport(vt))
  assert.ok(firstSelected.includes('Selected 1/2 · Second latency'))
  assert.ok(firstSelected.includes('[Selected]'), 'the figure paints the textual selection device')
  vt.sendInput('\x1bv')
  await vt.waitForRender()
  assert.ok(stripSgr(await viewport(vt)).includes('Selected 2/2 · Request latency'))
  vt.sendInput('\x1bv')
  await vt.waitForRender()
  assert.ok(stripSgr(await viewport(vt)).includes('Selected 1/2 · Second latency'), 'the selection cycles')
  vt.sendInput('\x1bc')
  await vt.waitForRender()
  assert.deepEqual(copied, [JSON.stringify(CHART_B, null, 2)], 'Alt+C copies the SELECTED figure')
  app.stop()
})

test('with no selection Alt+C/Alt+O answer with the select hint and never guess a figure', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const { vt, app, copied } = mountApp()
  const doc = `Before.\n\n${marker(REF_A)}\n\nAfter.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A, CHART)])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  vt.sendInput('\x1bc')
  await vt.waitForRender()
  const copyHint = stripSgr(await viewport(vt))
  assert.ok(copyHint.includes('Select a visual first') && copyHint.includes('Alt+V'), copyHint)
  assert.deepEqual(copied, [])
  vt.sendInput('\x1bo')
  await vt.waitForRender()
  const openHint = stripSgr(await viewport(vt))
  assert.ok(openHint.includes('Select a visual first') && openHint.includes('Alt+V'), openHint)
  app.stop()
})

test('a click on the figure title/description opens no viewer and never folds the answer', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = new SvgRasterLoader(async (_source, options) => ({
    png: new Uint8Array(),
    base64: TINY_PNG_BASE64,
    widthPx: options.targetWidth,
    heightPx: 8,
  }))
  const { vt, app } = mountApp({ svgLoader: loader })
  app.setFullscreen(true)
  const doc = `Before.\n\n${marker(REF_A)}\n\nAfter.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [svgPublication(REF_A)])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const before = await viewport(vt)
  await clickCell(vt, cellOf(before, 'Service topology'))
  const after = await viewport(vt)
  assert.equal(stripSgr(after), stripSgr(before), 'an inert figure cell neither opens the viewer nor folds the card')
  app.stop()
  loader.dispose()
})

test('a session replacement clears the selection and closes an open SVG viewer', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = new SvgRasterLoader(async (_source, options) => ({
    png: new Uint8Array(),
    base64: TINY_PNG_BASE64,
    widthPx: options.targetWidth,
    heightPx: 8,
  }))
  const { vt, app, copied } = mountApp({ svgLoader: loader })
  app.setFullscreen(true)
  const first = answerFolder(`Before.\n\n${marker(REF_A)}\n\nAfter.`)
  setAssistantVisualPresentation(first.assistant, key(), [svgPublication(REF_A)])
  app.setTranscript(first.folder.messages())
  await vt.waitForRender()
  vt.sendInput('\x1bv')
  await vt.waitForRender()
  assert.ok(stripSgr(await viewport(vt)).includes('Selected'))
  // Replace the whole presentation with a session whose rows do not own the
  // old figure: the selection is not transferable.
  const second = answerFolder('A different answer.\n\n' + marker(REF_B))
  setAssistantVisualPresentation(second.assistant, { ...key(), sessionId: 'session-b', turn: 0 }, [svgPublication(REF_B)])
  app.setTranscript(second.folder.messages())
  await vt.waitForRender()
  const replaced = await viewport(vt)
  assert.equal(stripSgr(replaced).includes('[Selected]'), false, 'the old selection device does not survive the subject change')
  vt.sendInput('\x1bc')
  await vt.waitForRender()
  assert.ok(stripSgr(await viewport(vt)).includes('Select a visual first'), 'the stale selection never authorizes a copy')
  assert.deepEqual([], copied, 'no payload was written for the retired selection')
  app.stop()
  loader.dispose()
})

test('the visual host actions are blocked from the parent surface inside a subagent viewer', () => {
  for (const action of ['app.visual.selectNext', 'app.visual.copySelected', 'app.visual.openSelected'] as const) {
    assert.equal(VIEWER_BLOCKED_PARENT_ACTIONS.has(action), true, `${action} must be parent-locked`)
  }
})


test('a click on the READY thumbnail pixel body opens the same leased SVG viewer', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = new SvgRasterLoader(async (_source, options) => ({
    png: new Uint8Array(),
    base64: TINY_PNG_BASE64,
    widthPx: options.targetWidth,
    heightPx: 16,
  }))
  const { vt, app } = mountApp({ svgLoader: loader })
  app.setFullscreen(true)
  const { folder, assistant } = answerFolder(`Before.\n\n${marker(REF_A)}\n\nAfter.`)
  setAssistantVisualPresentation(assistant, key(), [svgPublication(REF_A)])
  app.setTranscript(folder.messages())
  const settled = await settledViewport(vt)
  const lines = settled.split('\n')
  const lastDescriptionRow = lines.findIndex(line => line.includes('SVG source available in the expanded tool call')) + 1
  assert.ok(lastDescriptionRow > 0, `the description is painted:\n${settled}`)
  // The thumbnail contributes one spacer row, then the REAL pixel body rows
  // (the sequence itself is consumed by the virtual terminal's image layer).
  const pixelRow = lastDescriptionRow + 2
  assert.ok(stripSgr(lines[pixelRow - 1] ?? '').trim() === '', `the pixel body starts after the description:\n${settled}`)
  await clickCell(vt, { x: 4, y: pixelRow })
  const viewer = await viewport(vt)
  assert.ok(viewer.includes('SVG · Service topology'), `a real pixel-body click opens the viewer:\n${viewer}`)
  app.stop()
  loader.dispose()
})

test('a session replacement closes an open SVG viewer and never paints it on the successor', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = new SvgRasterLoader(async (_source, options) => ({
    png: new Uint8Array(),
    base64: TINY_PNG_BASE64,
    widthPx: options.targetWidth,
    heightPx: 8,
  }))
  const { vt, app } = mountApp({ svgLoader: loader })
  app.setFullscreen(true)
  const first = answerFolder(`Before.\n\n${marker(REF_A)}\n\nAfter.`)
  setAssistantVisualPresentation(first.assistant, key(), [svgPublication(REF_A)])
  app.setTranscript(first.folder.messages())
  await vt.waitForRender()
  await clickCell(vt, cellOf(await viewport(vt), 'View'))
  assert.ok((await viewport(vt)).includes('SVG · Service topology'), 'the viewer is open')
  const second = answerFolder('A different answer.')
  setAssistantVisualPresentation(second.assistant, { ...key(), sessionId: 'session-b' }, [svgPublication(REF_B)])
  app.setTranscript(second.folder.messages())
  await vt.waitForRender()
  const replaced = await viewport(vt)
  assert.equal(replaced.includes('SVG · Service topology'), false, 'the old viewer never survives the subject change')
  assert.ok(replaced.includes('A different answer.'), 'the successor transcript owns the surface')
  app.stop()
  loader.dispose()
})

test('a copy sink returning false or throwing reports failure and never claims success', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  for (const sink of [
    async (): Promise<boolean> => false,
    async (): Promise<boolean> => { throw new Error('clipboard unavailable') },
    (): Promise<boolean> => { throw new Error('clipboard unavailable synchronously') },
  ]) {
    const { vt, app } = mountApp({ copy: sink })
    const { folder, assistant } = answerFolder(`Before.\n\n${marker(REF_A)}\n\nAfter.`)
    setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A, CHART)])
    app.setTranscript(folder.messages())
    await vt.waitForRender()
    vt.sendInput('\x1bv')
    await vt.waitForRender()
    vt.sendInput('\x1bc')
    await vt.waitForRender()
    const view = stripSgr(await viewport(vt))
    assert.ok(view.includes('Copy failed'), `the failed sink is reported truthfully:\n${view}`)
    assert.equal(view.includes('Copied visual'), false)
    app.dispose()
  }
})

test('the three visual actions obey a user remap', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const { vt, app, copied } = mountApp()
  const diagnostics: string[] = []
  app.applyUserKeybindings({ 'app.visual.selectNext': 'alt+y', 'app.visual.copySelected': 'alt+u' }, message => {
    diagnostics.push(message)
  })
  assert.deepEqual(diagnostics, [])
  const { folder, assistant } = answerFolder(`Before.\n\n${marker(REF_A)}\n\nAfter.`)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A, CHART)])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  vt.sendInput('\x1bv')
  await vt.waitForRender()
  assert.equal(stripSgr(await viewport(vt)).includes('Selected'), false, 'the replaced default no longer fires')
  vt.sendInput('\x1by')
  await vt.waitForRender()
  assert.ok(stripSgr(await viewport(vt)).includes('Selected 1/1 · Request latency'))
  vt.sendInput('\x1bu')
  await vt.waitForRender()
  assert.deepEqual(copied, [JSON.stringify(CHART, null, 2)], 'the remapped copy action uses the same payload contract')
  app.stop()
})

test('the transcript-search overlay owns the key before the visual actions', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const { vt, app, copied } = mountApp()
  const { folder, assistant } = answerFolder(`Before.\n\n${marker(REF_A)}\n\nAfter.`)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A, CHART)])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  vt.sendInput('\x06') // Ctrl+F opens transcript search.
  await vt.waitForRender()
  vt.sendInput('\x1bv')
  await vt.waitForRender()
  const view = stripSgr(await viewport(vt))
  assert.equal(view.includes('Selected'), false, 'the visual selection never fires from behind the search overlay')
  vt.sendInput('\x1bc')
  await vt.waitForRender()
  assert.deepEqual(copied, [], 'no copy fires from behind the overlay')
  app.stop()
})


test('a copy settled after a subject replacement never posts its receipt on the successor', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  let release!: () => void
  const gate = new Promise<boolean>((resolve) => {
    release = () => resolve(true)
  })
  const { vt, app, copied } = mountApp({ copy: async () => await gate })
  const first = answerFolder(`Before.\n\n${marker(REF_A)}\n\nAfter.`)
  setAssistantVisualPresentation(first.assistant, key(), [chartPublication(REF_A, CHART)])
  app.setTranscript(first.folder.messages())
  await vt.waitForRender()
  vt.sendInput('\x1bv')
  await vt.waitForRender()
  vt.sendInput('\x1bc')
  // The sink is still pending; a new subject replaces the exact target.
  const second = answerFolder('A different answer.')
  setAssistantVisualPresentation(second.assistant, { ...key(), sessionId: 'session-b' }, [chartPublication(REF_B, CHART_B)])
  app.setTranscript(second.folder.messages())
  await vt.waitForRender()
  release()
  for (let index = 0; index < 10; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    await vt.waitForRender()
  }
  const view = stripSgr(await viewport(vt))
  assert.deepEqual(copied, [JSON.stringify(CHART, null, 2)], 'the pending write itself cannot be un-done or re-sent')
  assert.equal(view.includes('Copied visual'), false, 'the old result never reports on the successor')
  assert.equal(view.includes('Copy failed'), false, 'an ownership change is not a clipboard failure')
  app.stop()
})
