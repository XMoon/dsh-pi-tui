/**
 * The root-owned visual Assistant body: the real PiTui Markdown instances,
 * the display-only shared definitions prefix, the ordered chart/SVG components
 * and the single-bullet layout of the production `TuiApp`.
 * @module @xmoon76/dsh-pi-tui/tui/visual-assistant-body.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  Container,
  Markdown,
  resetCapabilitiesCache,
  setCapabilities,
} from '@xmoon76/pi-tui'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { TranscriptFolder, type TranscriptMessage } from '../../src/transcript.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { HOST_MARKDOWN_OPTIONS, markdownTheme } from '../../src/tui/theme/runtime.ts'
import { SharedDefinitionsMarkdown } from '../../src/tui/components/transcript/shared-definitions-markdown.ts'
import { VisualAssistantBody } from '../../src/tui/components/transcript/visual-assistant-body.ts'
import type { ImageGraphics } from '../../src/tui/graphics/native-image.ts'
import { setAssistantVisualPresentation, type VisualPresentationKey } from '../../src/domain/visual/presentation.ts'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'
import { svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import { RendererRegistry } from '../../src/extension/internal/renderer-registry.ts'
import type { ExtensionView } from '../../src/extension/public-types.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantLiveInput } from '../../src/runtime/assistant-stream-port.ts'
import { MessageId, type ContentBlock } from '@deepseek-ai/dsh-llm'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
  delete process.env.PI_IMAGE_PROTOCOL
  resetCapabilitiesCache()
})

/** A 1×1 transparent PNG (valid header, enough for the Image component). */
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/>'
  + '<text x="4" y="20" font-size="12" fill="#ffffff">Gateway</text></svg>'

const REF_A = `sv1_${'a'.repeat(20)}`
const REF_B = `sv1_${'b'.repeat(20)}`

function marker(ref: string): string {
  return `[dsh-visual-${ref}]: <#>`
}

/** The Assistant-body bullet row carrying a known answer/chart fragment. The
 * application brand and the Focus Thought header use the same whale glyph, so
 * the fragment is what distinguishes THIS answer's single bullet. */
function assistantBulletRows(view: string, fragment: string): string[] {
  return view.split('\n').filter(line => line.trimStart().startsWith('🐋')
    && !line.includes('dsh-pi-tui')
    && line.includes(fragment))
}

function chartPublication(ref: string, title = 'Request latency'): PublishedVisual {
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
      title,
      turn: 0,
      step: 0,
      stepStartSeq: 1,
      callSeq: 2,
      resultSeq: 3,
      callId: `chart-${ref.slice(-1)}`,
      chart: {
        version: 1,
        type: 'chart',
        kind: 'bars',
        title,
        unit: 'ms',
        series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
      },
      svg: undefined,
      svgSource: undefined,
      svgAdmissionWidth: undefined,
    },
  }
}

function svgPublication(ref: string): PublishedVisual {
  const args = { title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }
  const fact = svgFactFromArgs(args)
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
  assistant: Extract<ReturnType<TranscriptFolder['messages']>[number], { kind: 'assistant' }>
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
    (message): message is Extract<ReturnType<TranscriptFolder['messages']>[number], { kind: 'assistant' }> =>
      message.kind === 'assistant',
  )
  assert.ok(assistant !== undefined)
  return { folder, assistant }
}

function mountApp(options: {
  width?: number
  height?: number
  svgRasterLoader?: SvgRasterLoader
  preset?: 'full' | 'compact' | 'focus'
  copySelection?: (text: string) => Promise<boolean>
} = {}): {
  vt: VirtualTerminal
  app: TuiApp
} {
  const vt = new VirtualTerminal(options.width ?? 100, options.height ?? 60)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    ...(options.svgRasterLoader === undefined ? {} : { svgRasterLoader: options.svgRasterLoader }),
    ...(options.preset === undefined ? {} : { displayState: { preset: options.preset } }),
    ...(options.copySelection === undefined ? {} : { copySelection: options.copySelection }),
    imageTheme: { fallbackColor: text => text },
  })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

function prefixedDefinitions(count: number): string {
  return `${Array.from({ length: count }, (_, index) => `[d${index}]: https://example.com/${index}`).join('\n')}\n\n`
}

// ── SharedDefinitionsMarkdown ────────────────────────────────────────────

test('a reference link before a figure resolves through the display-only definitions prefix', () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const prefix = '[one]: https://example.com/one "One"\n\n'
  const segment = new SharedDefinitionsMarkdown({
    body: 'see [x][one]',
    definitions: prefix,
    theme: markdownTheme,
    markdownOptions: HOST_MARKDOWN_OPTIONS,
  })
  const rendered = segment.render(80).join('\n')
  assert.ok(rendered.includes('\x1b]8;;https://example.com/one'), 'the real renderer emits the prefix-resolved href')
  assert.ok(!rendered.includes('[x][one]'), 'the raw reference syntax is consumed by Markdown')
})

test('a link reference in a later text piece resolves against the same full-run prefix', () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const prefix = '[late]: https://example.com/late\n\n'
  const segment = new SharedDefinitionsMarkdown({
    body: 'later [y][late]',
    definitions: prefix,
    theme: markdownTheme,
    markdownOptions: HOST_MARKDOWN_OPTIONS,
  })
  const rendered = segment.render(80).join('\n')
  assert.ok(rendered.includes('\x1b]8;;https://example.com/late'))
  assert.ok(!rendered.includes('[y][late]'))
})

test('the definitions prefix adds no visible leading blank row', () => {
  const body = 'paragraph'
  const baseline = new Markdown(body, 0, 0, markdownTheme, undefined, HOST_MARKDOWN_OPTIONS).render(100)
  const segment = new SharedDefinitionsMarkdown({
    body,
    definitions: prefixedDefinitions(20),
    theme: markdownTheme,
    markdownOptions: HOST_MARKDOWN_OPTIONS,
  })
  const rendered = segment.render(100)
  assert.deepEqual(rendered, baseline)
})

test('the trim preserves a body-owned leading blank line', () => {
  const body = '\nparagraph'
  const baseline = new Markdown(body, 0, 0, markdownTheme, undefined, HOST_MARKDOWN_OPTIONS).render(100)
  const segment = new SharedDefinitionsMarkdown({
    body,
    definitions: prefixedDefinitions(5),
    theme: markdownTheme,
    markdownOptions: HOST_MARKDOWN_OPTIONS,
  })
  assert.deepEqual(segment.render(100), baseline)
})

test('a twenty-definition prefix over ten segments adds no rows at all', () => {
  const definitions = prefixedDefinitions(20)
  const body = (index: number): string => `paragraph ${index} with [link][d${index % 20}]`
  const baseline = new Container()
  const prefixed = new Container()
  for (let index = 0; index < 10; index += 1) {
    baseline.addChild(new Markdown(body(index), 0, 0, markdownTheme, undefined, HOST_MARKDOWN_OPTIONS))
    prefixed.addChild(new SharedDefinitionsMarkdown({
      body: body(index),
      definitions,
      theme: markdownTheme,
      markdownOptions: HOST_MARKDOWN_OPTIONS,
    }))
  }
  const baselineLines = baseline.render(100)
  const prefixedLines = prefixed.render(100)
  assert.equal(prefixedLines.length, baselineLines.length, 'the definition count never inflates the painted rows')
  const blankRows = (lines: readonly string[]): number[] =>
    lines.flatMap((line, index) => line.trim() === '' ? [index] : [])
  assert.deepEqual(blankRows(prefixedLines), blankRows(baselineLines),
    'the original paragraph spacing is preserved and no prefix row is added')
})

test('a resize re-renders both the prefix and the body at the new width', () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const segment = new SharedDefinitionsMarkdown({
    body: 'a paragraph with [link][one]',
    definitions: '[one]: https://example.com/one\n\n',
    theme: markdownTheme,
    markdownOptions: HOST_MARKDOWN_OPTIONS,
  })
  const narrow = segment.render(44)
  const wide = segment.render(100)
  assert.notDeepEqual(narrow, wide)
  assert.deepEqual(segment.render(44), narrow, 'the per-width cache is stable')
  assert.ok(narrow.join('\n').includes('\x1b]8;;'))
})

test('a CJK label and title in a CRLF definition prefix keeps the real href', () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const prefix = '[链接]: https://example.com/cjk "标题"\r\n\r\n'
  const segment = new SharedDefinitionsMarkdown({
    body: '参考 [x][链接]',
    definitions: prefix,
    theme: markdownTheme,
    markdownOptions: HOST_MARKDOWN_OPTIONS,
  })
  const rendered = segment.render(80).join('\n')
  assert.ok(rendered.includes('\x1b]8;;https://example.com/cjk'))
  assert.ok(!rendered.includes('[x][链接]'))
})

test('a definition prefix never changes a fenced code block or list body', () => {
  const body = 'before\n\n```ts\nconst x = 1\n```\n\n- one\n- two\n\nafter'
  const baseline = new Markdown(body, 0, 0, markdownTheme, undefined, HOST_MARKDOWN_OPTIONS).render(80)
  const segment = new SharedDefinitionsMarkdown({
    body,
    definitions: '[one]: https://example.com/one\n\n',
    theme: markdownTheme,
    markdownOptions: HOST_MARKDOWN_OPTIONS,
  })
  const rendered = segment.render(80)
  assert.equal(rendered.length, baseline.length)
  const text = rendered.join('\n')
  assert.ok(text.includes('const x = 1'))
  assert.ok(text.includes('• ') && text.includes('one') && text.includes('two'))
})

// ── the production TuiApp ordered Assistant body ──────────────────────────

test('one Assistant answer with inline figures paints one bullet and keeps source order', async () => {
  const doc = `Before figure.\n\n${marker(REF_A)}\n\nBetween figures.\n\n${marker(REF_B)}\n\nAfter figure.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A), chartPublication(REF_B, 'Second chart')])
  const { vt, app } = mountApp({ width: 100, height: 80 })
  await vt.waitForRender()
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const before = view.indexOf('Before figure.')
  const firstChart = view.indexOf('Request latency')
  const between = view.indexOf('Between figures.')
  const secondChart = view.indexOf('Second chart')
  const after = view.indexOf('After figure.')
  assert.ok(before >= 0 && firstChart > before && between > firstChart && secondChart > between && after > secondChart,
    `the source order is preserved:\n${view}`)
  assert.equal(assistantBulletRows(view, 'Before figure.').length, 1, `exactly one Agent bullet:\n${view}`)
  assert.ok(!view.includes('[dsh-visual-'), 'the marker definition is never painted')
  assert.ok(view.includes('42 ms') && view.includes('70 ms'), 'the exact chart values are visible')
  app.stop()
})

test('a marker at the very start paints the bullet before the first figure and no empty row', async () => {
  const doc = `${marker(REF_A)}\n\nAfter the figure.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A)])
  const { vt, app } = mountApp({ width: 100, height: 60 })
  await vt.waitForRender()
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const chart = view.indexOf('Request latency')
  const after = view.indexOf('After the figure.')
  assert.ok(chart >= 0 && after > chart, `the leading figure precedes the text:\n${view}`)
  assert.equal(assistantBulletRows(view, 'Request latency').length, 1)
  app.stop()
})

test('a trailing marker and a marker-only answer both keep the visual at the answer position', async () => {
  for (const doc of [`After text only.\n\n${marker(REF_A)}`, marker(REF_A)]) {
    const { folder, assistant } = answerFolder(doc)
    setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A)])
    const { vt, app } = mountApp({ width: 100, height: 60 })
    await vt.waitForRender()
    app.setTranscript(folder.messages(), folder.turnActivities())
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('Request latency'), `figure visible for ${JSON.stringify(doc)}:\n${view}`)
    const fragment = doc.startsWith('After text') ? 'After text only.' : 'Request latency'
    assert.equal(assistantBulletRows(view, fragment).length, 1, 'one Agent bullet')
    assert.ok(!view.includes('[dsh-visual-'))
    app.dispose()
  }
})

test('a half-streamed marker stays visible during the live turn and resolves only after terminal completion', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const folder = new TranscriptFolder()
  folder.apply([{ type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } } as unknown as SessionEvent])
  const partial: AssistantLiveInput = {
    kind: 'chunk', sessionId: 'stream-marker', attemptId: 'attempt-1', turn: 0, step: 0, time: 2,
    chunk: { type: 'text-delta', index: 0, text: 'Before.\n\n[dsh-visual-sv1_' },
  }
  folder.applyLiveInput(partial)
  const { vt, app } = mountApp({ width: 100, height: 60 })
  await vt.waitForRender()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const streaming = vt.getViewport().join('\n')
  assert.ok(streaming.includes('[dsh-visual-sv1_'), `the incomplete marker is the accepted transient text:\n${streaming}`)
  assert.equal(streaming.indexOf('Request latency'), -1, 'no figure is drawn before the complete terminal state')

  const text = `Before.\n\n${marker(REF_A)}\n\nAfter.`
  folder.apply([
    {
      type: 'assistant/message',
      seq: 1,
      time: 3,
      data: {
        turn: 0,
        step: 0,
        message: {
          id: MessageId('stream-marker-final'),
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    } as unknown as SessionEvent,
    { type: 'turn/end', seq: 2, time: 4, data: { turn: 0, reason: { kind: 'completed' } } } as unknown as SessionEvent,
  ])
  const assistant = folder.messages().find(
    (message): message is Extract<TranscriptMessage, { kind: 'assistant' }> => message.kind === 'assistant',
  )
  assert.ok(assistant !== undefined)
  setAssistantVisualPresentation(assistant, { ...key(), text: assistant.text }, [chartPublication(REF_A)])
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const settled = vt.getViewport().join('\n')
  const inline = settled.indexOf('Request latency', settled.indexOf('Before.'))
  assert.ok(inline > settled.indexOf('Before.') && inline < settled.indexOf('After.'),
    `the completed terminal state resolves the marker at its source position:\n${settled}`)
  assert.ok(!settled.includes('[dsh-visual-sv1_'), 'the complete marker definition is hidden')
  app.stop()
})

test('an SVG answer always paints the description and never a blank fake drawing', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const doc = `Before SVG.\n\n${marker(REF_A)}\n\nAfter SVG.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [svgPublication(REF_A)])
  const { vt, app } = mountApp({ width: 100, height: 60 })
  await vt.waitForRender()
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Service topology'), `SVG title visible:\n${view}`)
  assert.ok(view.includes('Gateway -> App -> Database'), `SVG description visible:\n${view}`)
  assert.ok(view.includes('Before SVG.') && view.includes('After SVG.'), 'the surrounding text survives')
  assert.ok(!view.includes('visual-v1:'), 'the machine credential never reaches the paint')
  app.stop()
})

test('an admitted SVG with a raster loader requests the exact admitted source once', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const requests: string[] = []
  const loader = new SvgRasterLoader(async (source) => {
    requests.push(source)
    return { png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 }
  })
  const doc = `Before.\n\n${marker(REF_A)}\n\nAfter.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [svgPublication(REF_A)])
  const { vt, app } = mountApp({ width: 100, height: 60, svgRasterLoader: loader })
  await vt.waitForRender()
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Service topology'))
  assert.deepEqual(requests, [SVG_SOURCE], 'the admitted source is the only raster input')
  app.stop()
})

test('a tail-only answer appends each published figure once after the body', async () => {
  const doc = 'No marker here.'
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [
    chartPublication(REF_A, 'Tail one'),
    chartPublication(REF_B, 'Tail two'),
  ])
  const { vt, app } = mountApp({ width: 100, height: 60 })
  await vt.waitForRender()
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const text = view.indexOf('No marker here.')
  const one = view.indexOf('Tail one')
  const two = view.indexOf('Tail two')
  assert.ok(text >= 0 && one > text && two > one, `tail order follows publication order:\n${view}`)
  app.stop()
})

test('an image block between text blocks keeps its existing marker row between the segments', async () => {
  const content = [
    { type: 'text' as const, text: `Before image.\n\n${marker(REF_A)}\n\n` },
    { type: 'image' as const, attachment: { type: 'image' as const, ref: 'img-1' } },
    { type: 'text' as const, text: 'After image.' },
  ]
  const { folder, assistant } = answerFolder('', content as ContentBlock[])
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A)])
  const { vt, app } = mountApp({ width: 100, height: 60 })
  await vt.waitForRender()
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Before image.') && view.includes('After image.'))
  assert.ok(view.indexOf('Before image.') < view.indexOf('Request latency'))
  assert.ok(view.indexOf('Request latency') < view.indexOf('After image.'))
  app.stop()
})

test('twenty definitions and ten figures paint without a linear blank-line prefix or a second bullet', async () => {
  const definitions = Array.from({ length: 20 }, (_, index) => `[d${index}]: https://example.com/${index}`).join('\n')
  const refs = Array.from({ length: 10 }, (_, index) => `sv1_${index.toString(16).padStart(20, '0')}`)
  const body = `${definitions}\n\nStart.\n\n${refs.map(ref => `${marker(ref)}\n\nfigure ${ref.slice(-2)}`).join('\n\n')}`
  const { folder, assistant } = answerFolder(body)
  setAssistantVisualPresentation(assistant, key(), refs.map((ref, index) => chartPublication(ref, `Chart ${index}`)))
  const { vt, app } = mountApp({ width: 120, height: 200 })
  await vt.waitForRender()
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const component = app.messageCacheEntryForTest(assistant)?.component
  assert.ok(component !== undefined)
  const rows = component.render(120)
  const painted = rows.join('\n')
  assert.equal(rows.filter(line => line.includes('🐋')).length, 1, 'one Assistant bullet for ten figures')
  for (let index = 0; index < 10; index += 1) assert.ok(painted.includes(`Chart ${index}`), `figure ${index} painted`)
  assert.ok(painted.includes('figure 09'), 'the tenth figure is inside the same ordered body')
  app.stop()
})

// ── delivery ordering, presets, resize, search and cache/disposal ─────────

test('tail visuals stay before the existing delivered-files tail', async () => {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as unknown as SessionEvent,
    {
      type: 'deliverables/presented',
      seq: 1,
      time: 2,
      data: { turn: 1, callId: 'present-1', files: [{ path: 'out/report.md', description: 'Report' }] },
    } as unknown as SessionEvent,
    {
      type: 'assistant/message',
      seq: 2,
      time: 3,
      data: {
        turn: 1,
        step: 0,
        message: {
          id: MessageId('delivered-answer'),
          role: 'assistant',
          content: [{ type: 'text', text: 'Answer body.' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    } as unknown as SessionEvent,
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent,
  ]
  folder.apply(events)
  const assistant = folder.messages().find(
    (message): message is Extract<ReturnType<TranscriptFolder['messages']>[number], { kind: 'assistant' }> =>
      message.kind === 'assistant',
  )
  assert.ok(assistant !== undefined)
  assert.deepEqual(assistant.deliverables?.map(file => file.path), ['out/report.md'])
  setAssistantVisualPresentation(assistant, { ...key(), turn: 1 }, [chartPublication(REF_A)])
  const { vt, app } = mountApp({ width: 100, height: 60 })
  await vt.waitForRender()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const body = view.indexOf('Answer body.')
  const chart = view.indexOf('Request latency', body)
  const delivered = view.indexOf('Delivered files · 1')
  assert.ok(body >= 0 && chart > body && delivered > chart, `tail visual precedes delivered files:\n${view}`)
  app.stop()
})

test('the same visual Assistant renders under full, compact and focus presets', async () => {
  const doc = `Before.\n\n${marker(REF_A)}\n\nAfter.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A)])
  const { vt, app } = mountApp({ width: 100, height: 80 })
  await vt.waitForRender()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  for (const preset of ['full', 'compact', 'focus'] as const) {
    const result = app.setDisplayPreset(preset)
    assert.ok(result.kind === 'applied' || result.kind === 'unchanged', `preset ${preset} is supported`)
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('Before.') && view.includes('After.'), `${preset}: text survives:\n${view}`)
    const chart = view.indexOf('Request latency', view.indexOf('Before.'))
    assert.ok(chart > view.indexOf('Before.') && chart < view.indexOf('After.'), `${preset}: inline chart:\n${view}`)
    assert.equal(assistantBulletRows(view, 'Before.').length, 1, `${preset}: one Assistant bullet`)
  }
  app.stop()
})

test('an inline visual Assistant reflows at every required terminal width', async () => {
  const doc = `Before narrow/wide.\n\n${marker(REF_A)}\n\nAfter narrow/wide.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A)])
  const { vt, app } = mountApp({ width: 120, height: 80 })
  await vt.waitForRender()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  for (const width of [44, 72, 100, 120, 200]) {
    vt.resize(width, 80)
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('Before narrow/wide.') && view.includes('After narrow/wide.'), `width ${width}: text visible`)
    assert.ok(view.includes('42 ms'), `width ${width}: exact chart value visible`)
    assert.equal(assistantBulletRows(view, 'Before narrow/wide.').length, 1, `width ${width}: one Assistant bullet`)
  }
  app.stop()
})

test('a visual sidecar revision rebuilds the one Assistant component and no other message', async () => {
  const doc = `Before.\n\nAfter.`
  const { folder, assistant } = answerFolder(doc)
  const { vt, app } = mountApp({ width: 100, height: 60 })
  await vt.waitForRender()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A)])
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Request latency'), 'the new figure is painted at the existing Assistant row')
  const before = app.transcriptPresentationDiagnosticsForTest()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const after = app.transcriptPresentationDiagnosticsForTest()
  assert.equal(after.noopCommits, before.noopCommits + 1,
    'an unchanged sidecar repaints as a no-op instead of rebuilding the Markdown/raster')
  assert.equal(app.messageCacheEntryForTest(assistant)?.visualPresentationRevision, 1,
    'the cache identity records the sidecar revision')
  app.stop()
})

function extensionTextView(text: string): ExtensionView {
  return { kind: 'text', spans: [{ text }] }
}

test('an installed assistant renderer owns the visual answer card; host fallback paints the ordered body', async () => {
  const doc = `Before ext.\n\n${marker(REF_A)}\n\nAfter ext.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A)])
  const registry = new RendererRegistry()
  const handle = registry.registerMessageRenderer({
    id: 'visual-owner-test',
    kind: 'assistant',
    render: snapshot => extensionTextView(`EXTENSION ASSISTANT ${snapshot.turn}`),
  }, 'test')
  const vt = new VirtualTerminal(100, 60)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    renderers: registry,
    imageTheme: { fallbackColor: text => text },
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const extensionView = vt.getViewport().join('\n')
  assert.ok(extensionView.includes('EXTENSION ASSISTANT 0'))
  assert.equal(extensionView.indexOf('Request latency'), -1,
    'the Host visual body never overlays an extension-owned card')
  handle.dispose()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const hostView = vt.getViewport().join('\n')
  assert.ok(!hostView.includes('EXTENSION ASSISTANT'), 'the extension view retired with its renderer')
  const inline = hostView.indexOf('Request latency', hostView.indexOf('Before ext.'))
  assert.ok(inline > hostView.indexOf('Before ext.') && inline < hostView.indexOf('After ext.'),
    `the Host fallback paints the published visual inline:\n${hostView}`)
  app.dispose()
})

test('a replaced SVG Assistant component releases its loader subscription even behind delivered files', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = new SvgRasterLoader(async () => ({
    png: new Uint8Array(),
    base64: TINY_PNG_BASE64,
    widthPx: 1,
    heightPx: 1,
  }))
  let subscribed = 0
  let unsubscribed = 0
  const originalSubscribe = loader.subscribe.bind(loader)
  loader.subscribe = (digest, targetWidth, listener) => {
    subscribed += 1
    const unsubscribe = originalSubscribe(digest, targetWidth, listener)
    return () => {
      unsubscribed += 1
      unsubscribe()
    }
  }
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as unknown as SessionEvent,
    {
      type: 'deliverables/presented',
      seq: 1,
      time: 2,
      data: { turn: 1, callId: 'present-1', files: [{ path: 'out/report.md' }] },
    } as unknown as SessionEvent,
    {
      type: 'assistant/message',
      seq: 2,
      time: 3,
      data: {
        turn: 1,
        step: 0,
        message: {
          id: MessageId('svg-delivery'),
          role: 'assistant',
          content: [{ type: 'text', text: `Before.\n\n${marker(REF_A)}\n\nAfter.` }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    } as unknown as SessionEvent,
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent,
  ]
  folder.apply(events)
  const assistant = folder.messages().find(
    (message): message is Extract<ReturnType<TranscriptFolder['messages']>[number], { kind: 'assistant' }> =>
      message.kind === 'assistant',
  )
  assert.ok(assistant !== undefined)
  setAssistantVisualPresentation(assistant, { ...key(), turn: 1 }, [svgPublication(REF_A)])
  const { vt, app } = mountApp({ width: 100, height: 60, svgRasterLoader: loader })
  await vt.waitForRender()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  assert.equal(subscribed, 1)
  // A new revision rebuilds the same row; the delivered-files wrapper must not
  // hide the visual body from disposal.
  setAssistantVisualPresentation(assistant, { ...key(), turn: 1 }, [svgPublication(REF_B)])
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  assert.equal(unsubscribed, 1, 'the replaced component released its listener')
  assert.equal(subscribed, 2, 'the rebuilt component subscribed exactly once')
  app.dispose()
  assert.equal(unsubscribed, 2, 'the final app teardown released the remaining listener')
})

test('a theme and icon-style switch repaints the same visual Assistant row without changing ownership', async () => {
  const doc = `Before theme.\n\n${marker(REF_A)}\n\nAfter theme.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A)])
  const { vt, app } = mountApp({ width: 100, height: 60 })
  await vt.waitForRender()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  app.applyTheme('light')
  app.setIconStyle('symbols')
  await vt.waitForRender()
  app.setIconStyle('minimal')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const inline = view.indexOf('Request latency', view.indexOf('Before theme.'))
  assert.ok(inline > view.indexOf('Before theme.') && inline < view.indexOf('After theme.'),
    `the visual stays inline after theme/icon changes:\n${view}`)
  assert.ok(view.includes('After theme.'))
  app.stop()
})


test('the visual Assistant keeps its layout facts across the frozen size matrix', async () => {
  const doc = `Before matrix.\n\n${marker(REF_A)}\n\nAfter matrix.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A)])
  const { vt, app } = mountApp({ width: 120, height: 40 })
  await vt.waitForRender()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  for (const [width, height] of [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const) {
    vt.resize(width, height)
    await vt.waitForRender()
    const component = app.messageCacheEntryForTest(assistant)?.component
    assert.ok(component !== undefined)
    const painted = component.render(width).join('\n')
    assert.ok(painted.includes('42 ms'), `${width}x${height}: chart value survives the matrix`)
    assert.equal(painted.split('🐋').length - 1, 1, `${width}x${height}: one bullet`)
    assert.ok(vt.getViewport().length === height, `${width}x${height}: the frame still paints`)
  }
  app.stop()
})

// ── F2: adjacent text blocks stay ONE Markdown document ───────────────────

test('cross-block bold around a skipped reasoning block survives a tail-only publication', async () => {
  const content: ContentBlock[] = [
    { type: 'text' as const, text: '**重要' },
    { type: 'reasoning' as const, text: 'internal reasoning' },
    { type: 'text' as const, text: '提醒**' },
  ]
  const { folder, assistant } = answerFolder('', content)
  const { vt, app } = mountApp({ width: 100, height: 60 })
  await vt.waitForRender()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const baselineComponent = app.messageCacheEntryForTest(assistant)?.component
  assert.ok(baselineComponent !== undefined)
  const baseline = baselineComponent.render(100)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A)])
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const visualComponent = app.messageCacheEntryForTest(assistant)?.component
  assert.ok(visualComponent !== undefined)
  const visual = visualComponent.render(100)
  const chart = visual.findIndex(line => line.includes('Request latency'))
  assert.ok(chart > 0, `tail chart exists:\n${visual.join('\n')}`)
  assert.deepEqual(visual.slice(0, chart), baseline,
    'the text body must remain the original merged Markdown document')
  assert.ok(!visual.slice(0, chart).join('\n').includes('**'), 'the bold span is not split')
  assert.ok(visual.slice(0, chart).join('\n').includes('重要提醒'), 'the complete bold text is present')
  app.dispose()
})

test('cross-block fenced code around a skipped reasoning block matches the original Markdown body', async () => {
  const content: ContentBlock[] = [
    { type: 'text' as const, text: '```ts\nconst x = 1' },
    { type: 'reasoning' as const, text: 'internal reasoning' },
    { type: 'text' as const, text: '\nconst y = 2\n```' },
  ]
  const { folder, assistant } = answerFolder('', content)
  const { vt, app } = mountApp({ width: 100, height: 60 })
  await vt.waitForRender()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const baselineComponent = app.messageCacheEntryForTest(assistant)?.component
  assert.ok(baselineComponent !== undefined)
  const baseline = baselineComponent.render(100)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A)])
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const visualComponent = app.messageCacheEntryForTest(assistant)?.component
  assert.ok(visualComponent !== undefined)
  const visual = visualComponent.render(100)
  const chart = visual.findIndex(line => line.includes('Request latency'))
  assert.ok(chart > 0, `tail chart exists:\n${visual.join('\n')}`)
  assert.deepEqual(visual.slice(0, chart), baseline,
    'a fenced code block spanning ContentBlocks stays one Markdown document')
  const body = visual.slice(0, chart).join('\n')
  assert.ok(body.includes('const x = 1') && body.includes('const y = 2'))
  app.dispose()
})


// ── A14: real key and copy paths over the visual card ─────────────────────

test('fullscreen drag selection copies the visual Assistant body and leaves one inline figure', async () => {
  const copied: string[] = []
  const doc = `Before copy.\n\n${marker(REF_A)}\n\nAfter copy.`
  const { folder, assistant } = answerFolder(doc)
  setAssistantVisualPresentation(assistant, key(), [chartPublication(REF_A)])
  const { vt, app } = mountApp({
    width: 100,
    height: 40,
    copySelection: async text => { copied.push(text); return true },
  })
  await vt.waitForRender()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const lines = vt.getViewport()
  const beforeRow = lines.findIndex(line => line.includes('Before copy.'))
  const chartRow = lines.findIndex(line => line.includes('Request latency'))
  assert.ok(beforeRow >= 0 && chartRow > beforeRow, `the visual rows are visible:\n${lines.join('\n')}`)
  // Mouse coordinates are viewport 1-based; drag from the answer row through
  // the chart body.
  vt.sendInput(`\x1b[<0;1;${beforeRow + 1}M`)
  vt.sendInput(`\x1b[<32;40;${chartRow + 1}M`)
  vt.sendInput(`\x1b[<0;40;${chartRow + 1}m`)
  await vt.waitForRender()
  assert.equal(copied.length, 1, `the drag reached the production copy policy:\n${lines.join('\n')}`)
  const text = copied[0] ?? ''
  assert.ok(text.includes('Before copy.'), 'the copied text carries the answer body')
  assert.ok(text.includes('Request latency'), 'the copied text carries the inline chart body')
  const after = vt.getViewport().join('\n')
  assert.equal(after.split('Request latency').length - 1, 1, 'copying never duplicates or removes the chart')
  app.stop()
})

// ── Image-8 / I8-2B: the body must not freeze a pre-commit SIXEL hit ──────

const SIXEL_BODY_PLACEMENT = '\x1bP0;1;q"1;1;320;160#0;2;100;0;0~\x1b\\'

function sixelBodyGraphics(state: { committed: boolean }): ImageGraphics {
  return {
    mode: 'sixel',
    canPaint: () => true,
    image: () => ({
      render: () => [SIXEL_BODY_PLACEMENT, '', ''],
      invalidate: () => {},
      paintedBodyAt: (width: number) => (state.committed ? { width, columns: 6, rows: 3 } : undefined),
      dispose: () => {},
    }),
    terminal: {} as never,
    screen: {} as never,
    observeScreen: () => {},
    resample: () => {},
    dispose: () => {},
  } as unknown as ImageGraphics
}

test('a SIXEL Assistant figure hit is read from the committed frame, not the render snapshot', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const state = { committed: false }
  const loader = new SvgRasterLoader(async (_source, options) => ({
    png: new Uint8Array(),
    base64: TINY_PNG_BASE64,
    widthPx: options.targetWidth,
    heightPx: Math.max(1, Math.round(options.targetWidth / 2)),
  }))
  const publication = svgPublication(REF_A)
  const body = new VisualAssistantBody({
    pieces: [{ kind: 'visual', ref: REF_A, publication, blockIndex: null, placement: 'tail' }],
    definitions: [],
    blocks: [],
    theme: markdownTheme,
    markdownOptions: HOST_MARKDOWN_OPTIONS,
    paint: text => text,
    requestRender: () => {},
    figure: () => ({
      publication,
      selected: () => false,
      paint: text => text,
      requestRender: () => {},
      onCopy: () => {},
      onView: () => {},
      svgLoader: loader,
      svgTheme: { fallbackColor: text => text },
      svgAdmissionWidth: 640,
      graphics: sixelBodyGraphics(state),
    }),
    nonText: () => undefined,
  })
  body.render(100)
  for (let index = 0; index < 40; index += 1) await new Promise(resolve => setImmediate(resolve))
  body.render(100)
  const before = body.paintedVisualHits(100)
  assert.equal(before.length, 1)
  assert.equal(before[0]!.thumbnailBody, undefined, 'the pre-commit render declares no pixel body')

  state.committed = true
  // No extra component render: the same body answers from the committed frame.
  const after = body.paintedVisualHits(100)
  assert.equal(after.length, 1)
  const hit = after[0]!
  assert.ok(hit.thumbnailBody !== undefined, 'the committed frame produces the pixel hit')
  assert.ok(hit.thumbnailBody.endRow > hit.thumbnailBody.startRow)
  assert.equal(hit.thumbnailBody.endCol, 6)
  assert.equal(hit.top, before[0]!.top, 'the figure top is the last-render position')
  assert.equal(hit.height, before[0]!.height, 'the figure height never moves with the raster')
  assert.deepEqual(hit.actions, before[0]!.actions, 'action rows stay the last-render snapshot')
  body.dispose()
  loader.dispose()
  resetCapabilitiesCache()
})
