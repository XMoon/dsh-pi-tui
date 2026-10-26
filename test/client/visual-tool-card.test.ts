/**
 * PR-D: the PiTui visual tool cards.
 *
 * The chart card draws the width-aware Unicode/list projection from the FINAL
 * durable machine line; the SVG card always keeps its description and source
 * availability, and only a matching credential + admission state adds the
 * raster. The machine line itself is never shown.
 *
 * @module @xmoon76/dsh-pi-tui/visual-tool-card.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createToolResultMessage, MessageId, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { chartContentBlocks, chartFactFromArgs } from '../../src/domain/visual/chart.ts'
import { svgContentBlocks, svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import { resetCapabilitiesCache, setCapabilities } from '@xmoon76/pi-tui'
import { setAssistantVisualPresentation } from '../../src/domain/visual/presentation.ts'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
  delete process.env.PI_IMAGE_PROTOCOL
  resetCapabilitiesCache()
})

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/>'
  + '<text x="4" y="20" font-size="12" fill="#ffffff">Gateway</text></svg>'

/** A 1×1 transparent PNG (valid header, enough for the Image component). */
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function toolEvents(name: string, args: unknown, blocks: readonly ContentBlock[]): never[] {
  return [
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 0, step: 0, callId: 'call-1', name, arguments: JSON.stringify(args) } } as never,
    {
      type: 'tool/result',
      seq: 2,
      time: 1,
      data: {
        turn: 0,
        step: 0,
        message: createToolResultMessage({ callId: ToolCallId('call-1'), content: blocks, isError: false }),
      },
    } as never,
  ]
}

function chartRows(): never[] {
  const fact = chartFactFromArgs({
    kind: 'bars',
    title: 'Request latency',
    unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  })
  return toolEvents('dsh_pi_tui_chart', {
    kind: 'bars',
    title: 'Request latency',
    unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  }, chartContentBlocks(fact))
}

function svgRows(overrides: { source?: string } = {}): { events: never[]; args: unknown } {
  const source = overrides.source ?? SVG_SOURCE
  const args = { title: 'Service topology', description: 'Gateway -> App -> Database', svg: source }
  const fact = svgFactFromArgs(args)
  return { events: toolEvents('dsh_pi_tui_svg', args, svgContentBlocks(fact)), args }
}

function mountApp(options: { width?: number; svgRasterLoader?: SvgRasterLoader } = {}): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(options.width ?? 100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    ...(options.svgRasterLoader === undefined ? {} : { svgRasterLoader: options.svgRasterLoader }),
    imageTheme: { fallbackColor: text => text },
  })
  app.start()
  startedApps.add(app)
  app.setTranscriptDetailExpanded(true)
  return { vt, app }
}

test('the chart card renders the exact values and never the machine line', async () => {
  const { vt, app } = mountApp({ width: 100 })
  await vt.waitForRender()
  const folder = new TranscriptFolder()
  folder.apply(chartRows())
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Chart'), `chart header missing:\n${view}`)
  assert.ok(view.includes('Request latency'), `the supplied title is the row summary:\n${view}`)
  assert.ok(view.includes('p50'), `exact label visible:\n${view}`)
  assert.ok(view.includes('42 ms'), `exact value visible:\n${view}`)
  assert.ok(view.includes('2 supplied values'), 'provenance visible')
  assert.ok(!view.includes('visual-v1:'), `the machine line must never be displayed:\n${view}`)
  app.stop()
})

test('a narrow chart card falls back to the plain label/value list', async () => {
  const { vt, app } = mountApp({ width: 42 })
  await vt.waitForRender()
  const folder = new TranscriptFolder()
  folder.apply(chartRows())
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('p50'), `label visible at 42 columns:\n${view}`)
  assert.ok(view.includes('42 ms'), `value visible at 42 columns:\n${view}`)
  app.stop()
})

test('a policy-replaced chart content shows the replacement and no chart fact', async () => {
  const { vt, app } = mountApp()
  await vt.waitForRender()
  const folder = new TranscriptFolder()
  folder.apply(toolEvents('dsh_pi_tui_chart', {}, [{ type: 'text', text: 'REPLACED by policy' }]))
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('REPLACED by policy'), `replacement text visible:\n${view}`)
  assert.ok(!view.includes('42 ms'), 'the old numbers are gone')
  app.stop()
})

test('the SVG card always shows the description; a matching credential adds the raster path', async () => {
  // This case proves the IMAGE-PROTOCOL branch. Never inherit the developer
  // terminal's detected capability: a no-TTY/CI parent must still pass.
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const requests: string[] = []
  const loader = new SvgRasterLoader(async (source) => {
    requests.push(source)
    return { png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 }
  })
  const { vt, app } = mountApp({ svgRasterLoader: loader })
  await vt.waitForRender()
  const { events } = svgRows()
  const folder = new TranscriptFolder()
  folder.apply(events)
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Gateway -> App -> Database'), `description visible without an image protocol:\n${view}`)
  assert.ok(view.includes('SVG source available in the expanded tool call'), 'source path visible')
  assert.ok(!view.includes('visual-v1:'), 'credential line hidden')
  // The pane detected inline images in this environment: the matching
  // credential fires exactly ONE request for the admitted source.
  assert.deepEqual(requests, [SVG_SOURCE], 'the admitted source is the only raster input')
  app.stop()
})

test('without an inline-image protocol the SVG card keeps the text and never rasters', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const requests: string[] = []
  const loader = new SvgRasterLoader(async (source) => {
    requests.push(source)
    return { png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 }
  })
  const { vt, app } = mountApp({ svgRasterLoader: loader })
  await vt.waitForRender()
  const folder = new TranscriptFolder()
  folder.apply(svgRows().events)
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Gateway -> App -> Database'), `description visible:\n${view}`)
  assert.ok(view.includes('SVG source available in the expanded tool call'), 'source path visible')
  assert.deepEqual(requests, [], 'no protocol means no raster work')
  app.stop()
})

test('a credential mismatch (policy value replacement) keeps the text and marks the drawing unavailable', async () => {
  const { vt, app } = mountApp()
  await vt.waitForRender()
  // The result carries a credential for a DIFFERENT source than the call args.
  const other = svgFactFromArgs({ title: 'Other', description: 'other figure', svg: `${SVG_SOURCE}<!-- other -->` })
  const { args } = svgRows()
  const folder = new TranscriptFolder()
  folder.apply(toolEvents('dsh_pi_tui_svg', args, svgContentBlocks(other)))
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('other figure'), `credential description visible:\n${view}`)
  assert.ok(view.includes('Drawing unavailable'), `mismatch reason visible:\n${view}`)
  app.stop()
})

test('a policy-replaced SVG content leaves the description path but no drawing', async () => {
  const { vt, app } = mountApp()
  await vt.waitForRender()
  const { args } = svgRows()
  const folder = new TranscriptFolder()
  folder.apply(toolEvents('dsh_pi_tui_svg', args, [{ type: 'text', text: 'REPLACED by policy' }]))
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('REPLACED by policy'), `replacement text visible:\n${view}`)
  assert.ok(view.includes('Drawing unavailable'), `the missing credential is explained:\n${view}`)
  app.stop()
})

test('a PTC child chart keeps its own card body and never leaks the machine line', async () => {
  const { vt, app } = mountApp({ width: 100 })
  await vt.waitForRender()
  const args = {
    kind: 'bars' as const,
    title: 'Child latency',
    unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  }
  const blocks = chartContentBlocks(chartFactFromArgs(args))
  const child = {
    kind: 'tool' as const,
    turn: 1,
    name: 'dsh_pi_tui_chart',
    args: JSON.stringify(args),
    result: blocks.map(block => block.type === 'text' ? block.text : '').join('\n'),
    status: 'ok' as const,
    resultBlocks: blocks,
    subCallId: 'parent:ptc:1',
  }
  const parent = {
    kind: 'tool' as const,
    turn: 1,
    name: 'run_code',
    args: '{}',
    result: 'parent result',
    status: 'ok' as const,
    callId: 'parent',
    resultBlocks: [{ type: 'text' as const, text: 'parent result' }],
    subCalls: [child],
  }
  app.setTranscript([parent as never])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Child latency'), `the child summary is visible:\n${view}`)
  assert.ok(view.includes('42 ms'), `the child exact value is visible:\n${view}`)
  assert.ok(!view.includes('visual-v1:'), `the child machine line is hidden:\n${view}`)
  app.stop()
})


test('a chart label/unit with OSC/CSI/C1 bytes never reaches the tty', async () => {
  const tui = mountApp({ width: 100 })
  const { vt, app } = tui
  await vt.waitForRender()
  // 7-bit OSC + BEL, 8-bit CSI (C1), 8-bit OSC (C1) and a C0 payload.
  const hostile = '\u001b]52;c;YXR0YWNr\u0007p50\u009b2J\u009d0;title\u0007\u0001'
  const args = {
    kind: 'bars' as const,
    title: 'Hostile',
    unit: `ms${hostile}`,
    series: [{ label: hostile, value: 42 }, { label: 'p99', value: 70 }],
  }
  const folder = new TranscriptFolder()
  folder.apply(toolEvents('dsh_pi_tui_chart', args, chartContentBlocks(chartFactFromArgs(args))))
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  // xterm consumes control bytes, so the security proof must inspect the RAW
  // writes; the viewport is only the readability check.
  const raw = vt.writes.join('')
  assert.ok(!raw.includes('\u001b]52'), 'the 7-bit OSC52 must not be written')
  assert.ok(!raw.includes('\u009b'), 'the 8-bit CSI (C1) must not be written')
  assert.ok(!raw.includes('\u009d'), 'the 8-bit OSC (C1) must not be written')
  assert.ok(!raw.includes('\u0001'), 'the C0 payload must not be written')
  assert.ok(view.includes('p50'), 'the readable label survives sanitization')
  app.stop()
})

test('a PTC SVG child with an OSC description never reaches the tty', async () => {
  const tui = mountApp({ width: 100 })
  const { vt, app } = tui
  await vt.waitForRender()
  const hostile = 'Gateway\u001b]52;c;YXR0YWNr\u0007 -> App\u009b2J\u009d0;title\u0007'
  const args = { title: 'Child topology', description: hostile, svg: SVG_SOURCE }
  const fact = svgFactFromArgs(args)
  const child = {
    kind: 'tool' as const, turn: 1, name: 'dsh_pi_tui_svg', args: JSON.stringify(args),
    result: svgContentBlocks(fact).map(block => block.type === 'text' ? block.text : '').join('\n'),
    status: 'ok' as const, resultBlocks: svgContentBlocks(fact), subCallId: 'parent:ptc:svg',
  }
  const parent = {
    kind: 'tool' as const, turn: 1, name: 'run_code', args: '{}', result: 'parent', status: 'ok' as const,
    callId: 'parent', resultBlocks: [{ type: 'text' as const, text: 'parent' }], subCalls: [child],
  }
  app.setTranscript([parent as never])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const raw = vt.writes.join('')
  assert.ok(!raw.includes('\u001b]52'), 'the child 7-bit OSC52 must not be written')
  assert.ok(!raw.includes('\u009b'), 'the child 8-bit CSI (C1) must not be written')
  assert.ok(!raw.includes('\u009d'), 'the child 8-bit OSC (C1) must not be written')
  assert.ok(view.includes('Gateway'), 'the readable description survives')
  app.stop()
})

test('the final fact title is visible after a value replacement', async () => {
  const { vt, app } = mountApp({ width: 100 })
  await vt.waitForRender()
  const args = {
    kind: 'bars' as const, title: 'ORIGINAL_CALL_TITLE', unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  }
  const replacement = {
    version: 1 as const, type: 'chart' as const, kind: 'bars' as const, title: 'FINAL_APPROVED_TITLE', unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  }
  const folder = new TranscriptFolder()
  folder.apply(toolEvents('dsh_pi_tui_chart', args, chartContentBlocks(replacement)))
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('FINAL_APPROVED_TITLE'), `the final fact title must be visible:\n${view}`)
  app.stop()
})

test('a blocked chart/SVG result with copied visual content never draws', async () => {
  const { vt, app } = mountApp({ width: 100 })
  await vt.waitForRender()
  const chartArgs = {
    kind: 'bars' as const, title: 'Blocked chart', unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  }
  const svgArgs = { title: 'Blocked svg', description: 'Blocked description', svg: SVG_SOURCE }
  const folder = new TranscriptFolder()
  const chartBlocks = chartContentBlocks(chartFactFromArgs(chartArgs))
  const svgBlocks = svgContentBlocks(svgFactFromArgs(svgArgs))
  folder.apply([
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 0, step: 0, callId: 'call-c', name: 'dsh_pi_tui_chart', arguments: JSON.stringify(chartArgs) } } as never,
    { type: 'tool/result', seq: 2, time: 1, data: { turn: 0, step: 0, message: createToolResultMessage({ callId: ToolCallId('call-c'), content: chartBlocks, isError: true }) } } as never,
    { type: 'tool/call', seq: 3, time: 1, data: { turn: 0, step: 0, callId: 'call-s', name: 'dsh_pi_tui_svg', arguments: JSON.stringify(svgArgs) } } as never,
    { type: 'tool/result', seq: 4, time: 1, data: { turn: 0, step: 0, message: createToolResultMessage({ callId: ToolCallId('call-s'), content: svgBlocks, isError: true }) } } as never,
  ])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Blocked description'), 'the blocked SVG keeps its readable description')
  assert.ok(!view.includes('#'), 'no chart bars are drawn for a blocked result')
  app.stop()
})

test('a PTC SVG child gets the same raster path with a fixed image budget', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const requests: string[] = []
  const loader = new SvgRasterLoader(async (source) => {
    requests.push(source)
    return { png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 }
  })
  const { vt, app } = mountApp({ svgRasterLoader: loader })
  await vt.waitForRender()
  const args = { title: 'Child topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }
  const fact = svgFactFromArgs(args)
  const blocks = svgContentBlocks(fact)
  const child = {
    kind: 'tool' as const, turn: 1, name: 'dsh_pi_tui_svg', args: JSON.stringify(args),
    result: blocks.map(block => block.type === 'text' ? block.text : '').join('\n'),
    status: 'ok' as const, resultBlocks: blocks, subCallId: 'parent:ptc:svg',
  }
  const parent = {
    kind: 'tool' as const, turn: 1, name: 'run_code', args: '{}', result: 'parent', status: 'ok' as const,
    callId: 'parent', resultBlocks: [{ type: 'text' as const, text: 'parent' }], subCalls: [child],
  }
  app.setTranscript([parent as never])
  await vt.waitForRender()
  assert.deepEqual(requests, [SVG_SOURCE], 'the child admits and rasterizes its own source')
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Gateway -> App -> Database'), 'the child description remains')
  app.stop()
})


function svgSource(index: number): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
    + `<rect width="64" height="32" fill="#3b82f6"/><text x="4" y="20" font-size="12">S${index}</text></svg>`
}

function svgRow(index: number): { args: { title: string; description: string; svg: string }; blocks: readonly ContentBlock[] } {
  const args = { title: `SVG ${index}`, description: `figure ${index}`, svg: svgSource(index) }
  return { args, blocks: svgContentBlocks(svgFactFromArgs(args)) }
}

test('a real top-level transcript with 77 SVG rows repaints without restarting a source', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  try {
    const calls = new Map<string, number>()
    const loader = new SvgRasterLoader(async (source) => {
      calls.set(source, (calls.get(source) ?? 0) + 1)
      return { png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 }
    })
    const { vt, app } = mountApp({ svgRasterLoader: loader })
    await vt.waitForRender()
    const folder = new TranscriptFolder()
    const events: unknown[] = []
    for (let index = 0; index < 77; index += 1) {
      const { args, blocks } = svgRow(index)
      const generated = toolEvents('dsh_pi_tui_svg', args, blocks) as unknown as Array<Record<string, unknown>>
      for (const [offset, event] of generated.entries()) {
        events.push({ ...event, seq: index * 2 + offset + 1 })
      }
    }
    folder.apply(events as never)
    app.setTranscript(folder.messages())
    await vt.waitForRender()
    for (let frame = 0; frame < 4; frame += 1) await vt.waitForRender()
    const before = new Map(calls)
    app.requestRender(true)
    await vt.waitForRender()
    assert.deepEqual([...calls.entries()].sort(), [...before.entries()].sort(), 'a repaint must not restart a live source')
    assert.ok([...calls.values()].every(count => count === 1), `each source starts at most once: ${JSON.stringify([...calls])}`)
    app.stop()
    loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('a real PTC card with 77 SVG children converges without retrying a live source', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  try {
    const calls = new Map<string, number>()
    const loader = new SvgRasterLoader(async (source) => {
      calls.set(source, (calls.get(source) ?? 0) + 1)
      return { png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 }
    })
    const { vt, app } = mountApp({ svgRasterLoader: loader })
    await vt.waitForRender()
    const children = Array.from({ length: 77 }, (_, index) => {
      const { args, blocks } = svgRow(index)
      return {
        kind: 'tool' as const,
        turn: 1,
        name: 'dsh_pi_tui_svg',
        args: JSON.stringify(args),
        result: blocks.map(block => block.type === 'text' ? block.text : '').join('\n'),
        status: 'ok' as const,
        resultBlocks: blocks,
        subCallId: `parent:ptc:${index}`,
      }
    })
    const parent = {
      kind: 'tool' as const,
      turn: 1,
      name: 'run_code',
      args: '{}',
      result: 'parent',
      status: 'ok' as const,
      callId: 'parent',
      resultBlocks: [{ type: 'text' as const, text: 'parent' }],
      subCalls: children,
    }
    app.setTranscript([parent as never])
    await vt.waitForRender()
    // Let the app's own repaint loop drain the bounded raster lane; stop as
    // soon as the frame no longer starts a new source (a bounded observation,
    // not a fixed sleep).
    for (let frame = 0; frame < 200; frame += 1) {
      const started = calls.size
      await vt.waitForRender()
      if (calls.size === started) break
    }
    const before = new Map(calls)
    app.requestRender(true)
    await vt.waitForRender()
    assert.deepEqual([...calls.entries()].sort(), [...before.entries()].sort(), 'a PTC repaint must not restart a live source')
    // The real app builds/paints only its current visible child set (13 here);
    // the >history-cap proof is the direct 77-thumbnail loader test above.
    assert.ok(calls.size > 12, `the visible child set must exceed the raster cache: ${JSON.stringify([...calls])}`)
    assert.ok([...calls.values()].every(count => count === 1), `each nested source starts at most once: ${JSON.stringify([...calls])}`)
    app.stop()
    loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})


test('a legal visual-v1: title/description still draws in the PiTui cards', async () => {
  const { vt, app } = mountApp({ width: 100 })
  await vt.waitForRender()
  const chartArgs = {
    kind: 'bars' as const,
    title: 'visual-v1: CPU usage',
    unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  }
  const chartFact = chartFactFromArgs(chartArgs)
  const svgArgs = { title: 'visual-v1: topology', description: 'visual-v1: Gateway -> App', svg: SVG_SOURCE }
  const svgFact = svgFactFromArgs(svgArgs)
  assert.ok(chartFact !== undefined && svgFact !== undefined)
  const folder = new TranscriptFolder()
  folder.apply([
    ...toolEvents('dsh_pi_tui_chart', chartArgs, chartContentBlocks(chartFact)),
    ...toolEvents('dsh_pi_tui_svg', svgArgs, svgContentBlocks(svgFact)),
  ] as never)
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.match(view, /visual-v1: CPU usage/u)
  assert.match(view, /42 ms/u)
  assert.match(view, /visual-v1: topology/u)
  assert.match(view, /visual-v1: Gateway -> App/u)
  assert.doesNotMatch(view, /visual-v1:\{"type"/u)
  app.stop()
})

/** The durable publication pair: the human summary plus the receipt block. */
function presentRows(): never[] {
  return [
    {
      type: 'tool/call', seq: 1, time: 1,
      data: { turn: 0, step: 1, callId: 'call-present', name: 'present_visual', arguments: JSON.stringify({ visuals: [{ ref: 'sv1_0123456789abcdef0123' }] }) },
    } as never,
    {
      type: 'tool/result', seq: 2, time: 1,
      data: {
        turn: 0, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('call-present'),
          content: [
            { type: 'text', text: 'Selected 1 visual for presentation.' },
            { type: 'text', text: 'visual-published-v1:{"version":1,"published":[{"ref":"sv1_0123456789abcdef0123"}]}' },
          ],
          isError: false,
        }),
      },
    } as never,
  ]
}

test('the publication card shows its human summary and never the receipt machine block', async () => {
  const { vt, app } = mountApp({ width: 100 })
  await vt.waitForRender()
  const folder = new TranscriptFolder()
  folder.apply(presentRows() as never)
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Present visuals'), `publication header missing:\n${view}`)
  assert.ok(view.includes('Selected 1 visual for presentation.'), `human summary missing:\n${view}`)
  assert.ok(!view.includes('visual-published-v1:'), `the receipt must never be painted:\n${view}`)
  assert.ok(!view.includes('sv1_'), `the raw ref never appears in the card:\n${view}`)
  app.stop()
})

test('a failed publication card keeps its readable reason and no receipt', async () => {
  const { vt, app } = mountApp({ width: 100 })
  await vt.waitForRender()
  const folder = new TranscriptFolder()
  folder.apply([
    {
      type: 'tool/call', seq: 1, time: 1,
      data: { turn: 0, step: 1, callId: 'call-bad', name: 'present_visual', arguments: JSON.stringify({ visuals: [{ ref: 'sv1_0123456789abcdef0123' }] }) },
    } as never,
    {
      type: 'tool/result', seq: 2, time: 1,
      data: {
        turn: 0, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('call-bad'),
          content: [{ type: 'text', text: 'unknown visual ref sv1_0123456789abcdef0123' }],
          isError: true,
        }),
      },
    } as never,
  ] as never)
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('unknown visual ref'), `the failure reason stays readable:\n${view}`)
  assert.ok(!view.includes('visual-published-v1:'), 'a failure never paints a receipt')
  app.stop()
})

test('a generated visual card never paints the projected reference block', async () => {
  const { vt, app } = mountApp({ width: 100 })
  await vt.waitForRender()
  const fact = chartFactFromArgs({
    kind: 'bars',
    title: 'Request latency',
    unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  })
  const blocks = chartContentBlocks(fact)
  const folder = new TranscriptFolder()
  folder.apply(toolEvents('dsh_pi_tui_chart', {
    kind: 'bars',
    title: 'Request latency',
    unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  }, [
    blocks[0] as ContentBlock,
    { type: 'text', text: 'visual-ref-v1:sv1_0123456789abcdef0123' },
    blocks[1] as ContentBlock,
  ]) as never)
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('p50'), `values visible with a reference block present:\n${view}`)
  assert.ok(!view.includes('visual-ref-v1:'), `the reference block must never be painted:\n${view}`)
  assert.ok(!view.includes('visual-v1:'), 'nor the fact machine line')
  app.stop()
})

test('the machine blocks stay hidden across the design-language size matrix', async () => {
  // docs/architecture/design-language.md §11.2 frozen matrix: the visual cards
  // must not leak a machine block at ANY of these widths, and the human values
  // must stay readable at each one.
  const fact = chartFactFromArgs({
    kind: 'bars',
    title: 'Request latency',
    unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  })
  const blocks = chartContentBlocks(fact)
  for (const [width, height] of [[200, 50], [120, 40], [100, 40], [80, 24], [72, 24], [44, 20]] as const) {
    const vt = new VirtualTerminal(width, height)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { imageTheme: { fallbackColor: text => text } })
    app.start()
    startedApps.add(app)
    app.setTranscriptDetailExpanded(true)
    const folder = new TranscriptFolder()
    folder.apply(toolEvents('dsh_pi_tui_chart', {
      kind: 'bars',
      title: 'Request latency',
      unit: 'ms',
      series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
    }, [
      blocks[0] as ContentBlock,
      { type: 'text', text: 'visual-ref-v1:sv1_0123456789abcdef0123' },
      blocks[1] as ContentBlock,
    ]) as never)
    app.setTranscript(folder.messages())
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(!view.includes('visual-ref-v1:'), `${width}x${height}: the reference block must never paint:\n${view}`)
    assert.ok(!view.includes('visual-v1:'), `${width}x${height}: the fact block must never paint:\n${view}`)
    assert.ok(view.includes('Request latency'), `${width}x${height}: the chart identity stays readable:\n${view}`)
    app.stop()
    disposeStartedApps()
  }
})


test('the Work tool card survives unchanged when the final answer also renders the published figure', async () => {
  const args = {
    kind: 'bars' as const,
    title: 'Request latency',
    unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  }
  const fact = chartFactFromArgs(args)
  const ref = `sv1_${'8'.repeat(20)}`
  const marker = `[dsh-visual-${ref}]: <#>`
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } } as never,
    ...chartRows(),
    {
      type: 'assistant/message',
      seq: 3,
      time: 3,
      data: {
        turn: 0,
        step: 1,
        message: {
          id: MessageId('tool-card-inline'),
          role: 'assistant',
          content: [{ type: 'text', text: `Before.\n\n${marker}\n\nAfter.` }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    } as never,
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 0, reason: { kind: 'completed' } } } as never,
  ])
  const assistant = folder.messages().find(
    (message): message is Extract<ReturnType<TranscriptFolder['messages']>[number], { kind: 'assistant' }> =>
      message.kind === 'assistant',
  )
  assert.ok(assistant !== undefined)
  const publication: PublishedVisual = {
    ref, turn: 0, step: 1, stepStartSeq: 5, callSeq: 6, resultSeq: 7, callId: 'present-tool-card',
    source: {
      ref, type: 'chart', title: fact.title, turn: 0, step: 0, stepStartSeq: 1, callSeq: 2, resultSeq: 3, callId: 'call-1',
      chart: fact, svg: undefined, svgSource: undefined, svgAdmissionWidth: undefined,
    },
  }
  setAssistantVisualPresentation(assistant, {
    subjectKind: 'main', subjectId: 'tool-card', sourceIdentity: {}, session: {}, sessionId: 'tool-card', seq: 4,
    turn: 0, step: 1, text: assistant.text, content: undefined, assistantRevision: 0,
  }, [publication])

  const { vt, app } = mountApp({ width: 100 })
  await vt.waitForRender()
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  // The Work card keeps its own title/values; the final answer adds ONE inline
  // copy at the marker position instead of replacing or hiding the Work row.
  assert.ok(view.includes('🛠️  Chart Request latency'), `the Work tool card is still painted:\n${view}`)
  const after = view.indexOf('After.')
  assert.ok(view.indexOf('Request latency', view.indexOf('Before.')) > view.indexOf('Before.'))
  assert.ok(view.indexOf('Request latency', view.indexOf('Before.')) < after)
  assert.ok(!view.includes('[dsh-visual-'))
  app.stop()
})
