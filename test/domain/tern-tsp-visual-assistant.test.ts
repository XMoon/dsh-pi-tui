/**
 * The pure TSP projection of an Assistant that owns published visuals.
 *
 * The chain under test is the PRODUCTION mapper plus the PRODUCTION placement
 * planner: the canonical structure → `transcriptView` → the published-visual
 * sidecar → `planVisualPlacement` → official `@stencil-hq/tern` nodes. No
 * session, no SDK surface and no blob sender: this proves the node tree the
 * mapper builds and the payloads it does NOT invent.
 *
 * STANDING-IN (never claimed as production): the `PublishedVisual[]` are
 * qualified-fact fixtures and the sidecar is attached directly (the real
 * PR1→PR2 derivation through the official Session log is proven by the
 * application/integration suites); the non-text image state is the DTO the TSP
 * session layer supplies.
 * @module @xmoon76/dsh-pi-tui/domain/tern-tsp-visual-assistant.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Node } from '@stencil-hq/tern'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import { setAssistantVisualPresentation } from '../../src/domain/visual/presentation.ts'
import type { PublishedVisual, VisualSource } from '../../src/domain/visual/publication.ts'
import type { ChartFact } from '../../src/domain/visual/chart.ts'
import type { SvgFact } from '../../src/domain/visual/svg.ts'
import {
  TranscriptNodeKeys,
  transcriptView,
  type ToolImageState,
} from '../../src/tui/tsp/transcript-view.ts'

// ── Fixtures ────────────────────────────────────────────────────────────────

const CHART: ChartFact = {
  version: 1,
  type: 'chart',
  kind: 'bars',
  title: 'Request latency',
  unit: 'ms',
  series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 71 }],
}

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/></svg>'

const SVG: SvgFact = {
  version: 1,
  type: 'svg',
  title: 'Dependencies',
  description: 'Gateway to database',
  digest: 'a'.repeat(64),
  bytes: SVG_SOURCE.length,
}

const REF_CHART = `sv1_${'1'.repeat(20)}`
const REF_SVG = `sv1_${'2'.repeat(20)}`
const REF_THIRD = `sv1_${'3'.repeat(20)}`

function visualSource(overrides: Partial<VisualSource> & { readonly ref: string; readonly type: 'chart' | 'svg' }): VisualSource {
  return {
    title: overrides.type === 'chart' ? CHART.title : SVG.title,
    turn: 1,
    step: 0,
    stepStartSeq: 10,
    callSeq: 11,
    resultSeq: 12,
    callId: `call-${overrides.ref.slice(-4)}`,
    chart: undefined,
    svg: undefined,
    svgSource: undefined,
    svgAdmissionWidth: undefined,
    ...overrides,
  }
}

function chartPublication(ref = REF_CHART): PublishedVisual {
  return {
    ref,
    turn: 1,
    step: 0,
    stepStartSeq: 20,
    callSeq: 21,
    resultSeq: 22,
    callId: `present-${ref.slice(-4)}`,
    source: visualSource({ ref, type: 'chart', chart: CHART }),
  }
}

function svgPublication(ref = REF_SVG): PublishedVisual {
  return {
    ref,
    turn: 1,
    step: 0,
    stepStartSeq: 20,
    callSeq: 21,
    resultSeq: 22,
    callId: `present-${ref.slice(-4)}`,
    source: visualSource({ ref, type: 'svg', svg: SVG, svgSource: SVG_SOURCE, svgAdmissionWidth: 640 }),
  }
}

function marker(ref: string): string {
  return `[dsh-visual-${ref}]: <#>`
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text } as ContentBlock
}

function imageBlock(attachment: unknown = {
  attachmentId: 'att-body-1',
  mediaType: 'image/png',
  bytes: 3_891,
  width: 640,
  height: 360,
  name: 'shot.png',
}): ContentBlock {
  return { type: 'image', attachment } as unknown as ContentBlock
}

function assistantRow(text: string, content?: readonly ContentBlock[]): Extract<TranscriptMessage, { kind: 'assistant' }> {
  return {
    kind: 'assistant',
    turn: 1,
    text,
    ...(content === undefined ? {} : { content }),
  }
}

/** Attach the display-only sidecar to the exact row (the PR2 handoff). */
function present(message: TranscriptMessage, publications: readonly PublishedVisual[]): void {
  const text = 'text' in message && typeof message.text === 'string' ? message.text : ''
  const content = 'content' in message ? message.content : undefined
  setAssistantVisualPresentation(message, {
    subjectKind: 'main',
    subjectId: 'session-1',
    sourceIdentity: {},
    session: {},
    sessionId: 'session-1',
    seq: 1,
    turn: 1,
    step: 0,
    text,
    content,
    assistantRevision: 0,
  }, publications)
}

interface ViewOptions {
  readonly chartKindsSupported?: boolean
  readonly nativeImagesSupported?: boolean
  readonly imageStates?: ReadonlyMap<string, ToolImageState>
  readonly requestPublishedSvgBlob?: (publication: PublishedVisual) => string | undefined
  readonly selectedVisual?: { readonly ref: string; readonly index: number; readonly count: number }
}

/** The assistant card the production mapper builds for one row. */
function cardOf(message: TranscriptMessage, options: ViewOptions = {}): Node {
  const view = transcriptView(projectTranscriptStructure([message]), new TranscriptNodeKeys(), {
    chartKindsSupported: options.chartKindsSupported,
    nativeImagesSupported: options.nativeImagesSupported,
    ...(options.imageStates === undefined ? {} : { imageStates: options.imageStates }),
    ...(options.requestPublishedSvgBlob === undefined ? {} : { requestPublishedSvgBlob: options.requestPublishedSvgBlob }),
    ...(options.selectedVisual === undefined ? {} : { selectedVisual: options.selectedVisual }),
  })
  const card = view.children.find(child => child.kind === 'card' && child.props['head'] === 'Assistant')
  assert.ok(card !== undefined, 'the Assistant row must render one Assistant card')
  return card
}

function nodesOfKind(node: Node, kind: string): Node[] {
  const out: Node[] = []
  const walk = (candidate: Node): void => {
    if (candidate.kind === kind) out.push(candidate)
    for (const child of candidate.children) walk(child)
  }
  walk(node)
  return out
}

function figureNodes(card: Node): Node[] {
  return card.children.filter(child => child.kind === 'col' && child.props['role'] === 'dsh.visual.figure')
}

function figureKeys(card: Node): string[] {
  return figureNodes(card).map(node => String(node.props['key']))
}

function mdTexts(card: Node): string[] {
  return nodesOfKind(card, 'md').map(node => String(node.props['text']))
}

function codeTexts(card: Node): string[] {
  return nodesOfKind(card, 'code').map(node => String(node.props['text']))
}

function copyButtons(card: Node): Node[] {
  return nodesOfKind(card, 'el').filter(node => node.props['role'] === 'dsh.visual.copy')
}

function headRowOf(figure: Node): Node {
  const row = figure.children.find(child => child.kind === 'row' && child.props['key'] === 'visual-head')
  assert.ok(row !== undefined, 'the figure must carry its own head row')
  return row
}

// ── Placement and card shape ────────────────────────────────────────────────

test('a chart marked between two paragraphs stays one Assistant card with the figure in place', () => {
  const publication = chartPublication()
  const message = assistantRow(`Before figure.\n\n${marker(publication.ref)}\n\nAfter figure.`)
  present(message, [publication])
  const card = cardOf(message, { chartKindsSupported: true })

  assert.equal(card.props['head'], 'Assistant')
  assert.deepEqual(figureKeys(card), [`body-visual-${publication.ref}`])
  assert.deepEqual(mdTexts(card), ['Before figure.\n\n', '\n\nAfter figure.'])
  // The visible marker line never survives as text.
  assert.equal(mdTexts(card).some(text => text.includes('dsh-visual-')), false)
})

test('a published visual no marker names is appended after the answer exactly once', () => {
  const publication = chartPublication()
  const message = assistantRow('Only prose.')
  present(message, [publication])
  const card = cardOf(message)

  assert.deepEqual(mdTexts(card), ['Only prose.'])
  assert.deepEqual(figureKeys(card), [`body-visual-${publication.ref}`])
})

test('a marker on the first line starts the card with the figure and keeps the tail text', () => {
  const publication = chartPublication()
  const message = assistantRow(`${marker(publication.ref)}\n\nBody after.`)
  present(message, [publication])

  // The consumed first line leaves its own trailing newline as the first run.
  assert.deepEqual(mdTexts(cardOf(message)), ['\n\nBody after.'])
})

test('two consecutive markers paint two figures without a phantom text run', () => {
  const chart = chartPublication()
  const svg = svgPublication()
  const message = assistantRow(`Intro\n\n${marker(chart.ref)}\n${marker(svg.ref)}\n\nOutro`)
  present(message, [chart, svg])
  const card = cardOf(message)

  assert.deepEqual(figureKeys(card), [
    `body-visual-${chart.ref}`,
    `body-visual-${svg.ref}`,
  ])
  // The single newline BETWEEN the two consumed marker lines is source
  // whitespace (the planner never drops it), not a fabricated marker row.
  assert.deepEqual(mdTexts(card), ['Intro\n\n', '\n', '\n\nOutro'])
})

test('a marker-only answer paints exactly the two figures and no body text', () => {
  const chart = chartPublication()
  const svg = svgPublication()
  const message = assistantRow(`${marker(chart.ref)}\n\n${marker(svg.ref)}`)
  present(message, [chart, svg])
  const card = cardOf(message)

  assert.deepEqual(figureKeys(card), [
    `body-visual-${chart.ref}`,
    `body-visual-${svg.ref}`,
  ])
  assert.deepEqual(mdTexts(card), ['\n\n'])
})

test('a repeated marker for one publication paints that figure once', () => {
  const publication = chartPublication()
  const message = assistantRow(`${marker(publication.ref)}\n\nAgain:\n\n${marker(publication.ref)}\n\nTail`)
  present(message, [publication])
  const card = cardOf(message)

  // The planner consumes only the FIRST occurrence of a published ref; the
  // repeated marker line keeps its source bytes as ordinary visible text.
  assert.equal(figureNodes(card).length, 1)
  assert.deepEqual(mdTexts(card), [`\n\nAgain:\n\n${marker(publication.ref)}\n\nTail`])
})

test('three qualified publications paint two figures when only two were published', () => {
  const chart = chartPublication()
  const svg = svgPublication()
  const third = chartPublication(REF_THIRD)
  const message = assistantRow(`Text\n\n${marker(chart.ref)}\n${marker(REF_THIRD)}\n${marker(svg.ref)}`)
  // The third source exists in the turn but was never published; the sidecar
  // carries only the two accepted publications.
  present(message, [chart, svg])
  const card = cardOf(message)

  assert.deepEqual(figureKeys(card), [
    `body-visual-${chart.ref}`,
    `body-visual-${svg.ref}`,
  ])
  assert.equal(mdTexts(card).some(text => text.includes(`${marker(REF_THIRD)}`)), true,
    'an unpublished marker line is ordinary display text, never a figure')
  assert.equal(third.source.chart !== undefined, true)
})

test('an Assistant without a visual presentation keeps its exact legacy body', () => {
  const message = assistantRow('Plain answer')
  const card = cardOf(message)

  assert.deepEqual(card.children.map(child => [child.kind, child.props['key'], child.props['text']]), [
    ['md', 'body', 'Plain answer'],
  ])
})

// ── Charts ──────────────────────────────────────────────────────────────────

test('a native-capable pane paints one chart node plus the exact value rows', () => {
  const publication = chartPublication()
  const message = assistantRow(`Latency:\n\n${marker(publication.ref)}`)
  present(message, [publication])
  const card = cardOf(message, { chartKindsSupported: true })

  const charts = nodesOfKind(card, 'chart')
  assert.equal(charts.length, 1)
  assert.equal(charts[0]?.props['kind'], 'bars')
  assert.equal(charts[0]?.props['summary'], 'Request latency (ms)')
  assert.deepEqual(charts[0]?.props['series'], [
    { label: 'p50', value: 42 },
    { label: 'p99', value: 71 },
  ])
  assert.deepEqual(codeTexts(card), ['p50  42 ms\np99  71 ms\n2 supplied values'])
  assert.equal((headRowOf(figureNodes(card)[0] as Node).children[0]?.props['text']), 'Chart · Request latency (ms)')
})

test('a pane without the chart kind keeps the full title and every exact value as text', () => {
  const publication = chartPublication()
  const message = assistantRow(`Latency:\n\n${marker(publication.ref)}`)
  present(message, [publication])
  const card = cardOf(message, { chartKindsSupported: false })

  assert.equal(nodesOfKind(card, 'chart').length, 0)
  assert.deepEqual(codeTexts(card), ['Request latency (ms)\np50  42 ms\np99  71 ms\n2 supplied values'])
})

// ── SVG ─────────────────────────────────────────────────────────────────────

test('an image+blob-capable pane paints the description, one zoomable image and asks the sender once', () => {
  const publication = svgPublication()
  const message = assistantRow(`Dependencies:\n\n${marker(publication.ref)}`)
  present(message, [publication])
  const requests: PublishedVisual[] = []
  const card = cardOf(message, {
    nativeImagesSupported: true,
    requestPublishedSvgBlob: (requested) => {
      requests.push(requested)
      return 'b'.repeat(64)
    },
  })

  const images = nodesOfKind(card, 'image')
  assert.equal(images.length, 1)
  assert.equal(images[0]?.props['blob'], 'b'.repeat(64))
  assert.equal(images[0]?.props['alt'], 'Dependencies')
  assert.deepEqual(images[0]?.props['actions'], { click: 'zoom' })
  assert.deepEqual(requests, [publication])
  assert.deepEqual(codeTexts(card), ['Dependencies\nGateway to database\nSVG source available in the expanded tool call'])
})

test('a pane without the full image capability still paints the description and never asks for a blob', () => {
  const publication = svgPublication()
  const message = assistantRow(`${marker(publication.ref)}`)
  present(message, [publication])
  const requests: PublishedVisual[] = []
  const card = cardOf(message, {
    nativeImagesSupported: false,
    requestPublishedSvgBlob: (requested) => {
      requests.push(requested)
      return 'b'.repeat(64)
    },
  })

  assert.equal(nodesOfKind(card, 'image').length, 0)
  assert.equal(requests.length, 0)
  assert.deepEqual(codeTexts(card), ['Dependencies\nGateway to database\nSVG source available in the expanded tool call'])
})

test('a published SVG whose admitted source is missing paints no image and no dead Copy control', () => {
  const publication = svgPublication()
  const broken: PublishedVisual = {
    ...publication,
    source: { ...publication.source, svgSource: undefined, svgAdmissionWidth: undefined },
  }
  const message = assistantRow(`${marker(broken.ref)}`)
  present(message, [broken])
  const card = cardOf(message, { nativeImagesSupported: true, requestPublishedSvgBlob: () => 'b'.repeat(64) })

  assert.equal(nodesOfKind(card, 'image').length, 0)
  assert.equal(copyButtons(card).length, 0)
  assert.deepEqual(
    nodesOfKind(card, 'text').map(node => node.props['text']).filter(text => typeof text === 'string' && text.startsWith('Drawing unavailable')),
    ['Drawing unavailable — the visual fact is missing'],
  )
})

// ── Copy controls and selection ─────────────────────────────────────────────

test('each figure carries exactly one real Copy button with its frozen label, aria and action', () => {
  const chart = chartPublication()
  const svg = svgPublication()
  const message = assistantRow(`${marker(chart.ref)}\n\n${marker(svg.ref)}`)
  present(message, [chart, svg])
  const card = cardOf(message)
  const buttons = copyButtons(card)

  assert.equal(buttons.length, 2)
  assert.deepEqual(buttons.map(button => [button.props['key'], button.props['aria'], button.props['text']]), [
    ['visual-copy', 'Copy chart data', 'Copy Data'],
    ['visual-copy', 'Copy SVG', 'Copy SVG'],
  ])
  for (const button of buttons) {
    assert.deepEqual(button.props['actions'], { click: 'dsh-visual-copy' })
  }
})

test('only the selected figure paints the Selected position badge', () => {
  const chart = chartPublication()
  const svg = svgPublication()
  const message = assistantRow(`${marker(chart.ref)}\n\n${marker(svg.ref)}`)
  present(message, [chart, svg])
  const card = cardOf(message, { selectedVisual: { ref: svg.ref, index: 2, count: 2 } })

  const badges = nodesOfKind(card, 'badge')
  assert.deepEqual(badges.map(badge => badge.props['text']), ['Selected · 2/2'])
  assert.equal(headRowOf(figureNodes(card)[0] as Node).children.some(child => child.props['key'] === 'visual-selected'), false)
})

// ── Text fidelity and shared definitions ────────────────────────────────────

test('a definition placed after its two references is supplied to both display runs', () => {
  const publication = chartPublication()
  const message = assistantRow(
    `See [docs][ref] first.\n\n${marker(publication.ref)}\n\nAnd [docs][ref] again.\n\n[ref]: https://example.com/docs`,
  )
  present(message, [publication])
  const card = cardOf(message)
  const runs = mdTexts(card)

  assert.equal(runs.length, 2)
  for (const run of runs) {
    assert.equal(run.startsWith('[ref]: https://example.com/docs\n\n'), true)
    assert.match(run, /\[docs\]\[ref\]/u)
  }
})

test('twenty ordinary definitions and ten figures keep every definition in every run without a marker leak', () => {
  const publications = Array.from({ length: 10 }, (_, index) => chartPublication(`sv1_${String(index + 4).padStart(20, '0')}`))
  const definitions = Array.from({ length: 20 }, (_, index) => `[link${index}]: https://example.com/${index}`)
  const body = [
    `Intro [a][link0] [b][link19].`,
    ...publications.map(publication => `\n\n${marker(publication.ref)}\n\nAfter ${publication.ref.slice(-2)} [c][link1].`),
    `\n\n${definitions.join('\n')}`,
  ].join('')
  const message = assistantRow(body)
  present(message, publications)
  const card = cardOf(message)
  const runs = mdTexts(card)

  assert.equal(figureNodes(card).length, 10)
  assert.equal(runs.length, 11)
  for (const run of runs) {
    if (run === '') continue
    assert.equal(run.startsWith(`${definitions.join('\n')}\n\n`), true, 'each run carries the shared definitions once')
    assert.equal(run.includes('dsh-visual-'), false, 'no visual marker label leaks into the display markdown')
  }
})

test('CJK, emoji, tabs and CRLF survive while a marker line is consumed', () => {
  const publication = chartPublication()
  const message = assistantRow(`标题\t值\r\n\r\n${marker(publication.ref)}\r\n\r\n末尾 😀\r\n`)
  present(message, [publication])
  const card = cardOf(message)

  assert.equal(figureNodes(card).length, 1)
  const runs = mdTexts(card).join('')
  // The display projection expands a tab to three spaces (the shared policy).
  assert.equal(runs.includes('标题   值'), true)
  assert.equal(runs.includes('末尾 😀'), true)
  assert.equal(runs.includes('dsh-visual-'), false)
})

test('reasoning and tool-call blocks neither paint nor interrupt the Markdown run', () => {
  const publication = chartPublication()
  const message = assistantRow('', [
    textBlock('Before '),
    { type: 'reasoning', text: 'internal' } as unknown as ContentBlock,
    textBlock('after.'),
    { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' } as unknown as ContentBlock,
  ])
  present(message, [publication])
  const card = cardOf(message)

  assert.deepEqual(mdTexts(card), ['Before after.'])
  assert.equal(nodesOfKind(card, 'code').some(node => String(node.props['text']).includes('reasoning')), false)
  assert.deepEqual(figureKeys(card), [`body-visual-${publication.ref}`])
})

test('a marker inside a fenced code block or an indented line is ordinary visible text', () => {
  const publication = chartPublication()
  const message = assistantRow([
    '```md',
    marker(publication.ref),
    '```',
    '',
    `    ${marker(REF_SVG)}`,
  ].join('\n'))
  present(message, [publication])
  const card = cardOf(message)

  // Neither line qualified as a marker, so the literal lines stay visible and
  // the still-published visual is appended once at the tail (never duplicated).
  assert.equal(figureNodes(card).length, 1)
  assert.equal(mdTexts(card)[0]?.includes(marker(publication.ref)), true)
})

test('a marker line with a trailing space is not the exact definition and stays text', () => {
  const publication = chartPublication()
  const message = assistantRow(`${marker(publication.ref)} `)
  present(message, [publication])
  const card = cardOf(message)

  // The exact line did not qualify as a marker, so the publication is tailed
  // after the visible literal line.
  assert.equal(figureNodes(card).length, 1)
  assert.equal(mdTexts(card)[0]?.includes(marker(publication.ref)), true)
})

// ── Non-text ContentBlocks ──────────────────────────────────────────────────

test('an Assistant image block keeps its existing renderer between the texts and the figure', () => {
  const publication = chartPublication()
  const message = assistantRow('', [
    textBlock('Before '),
    imageBlock(),
    textBlock('After.'),
  ])
  present(message, [publication])
  const card = cardOf(message, {
    imageStates: new Map([['att-body-1', { state: 'ready', blobId: 'c'.repeat(64) }]]),
  })

  assert.deepEqual(card.children.map(child => [child.kind, child.props['key']]), [
    ['md', 'body-run-0'],
    ['text', 'body-b1-info'],
    ['image', 'body-b1-image'],
    ['md', 'body-run-1'],
    ['col', `body-visual-${publication.ref}`],
  ])
  assert.equal(card.children[3]?.props['text'], 'After.')
  assert.equal(card.children[4]?.kind, 'col')
})

test('an Assistant image block without a publication keeps the legacy image body and asks no sender', () => {
  const message = assistantRow('', [textBlock('Before '), imageBlock()])
  const card = cardOf(message, {
    imageStates: new Map([['att-body-1', { state: 'ready', blobId: 'c'.repeat(64) }]]),
  })

  assert.deepEqual(card.children.map(child => child.kind), ['md', 'text', 'image'])
  assert.equal(figureNodes(card).length, 0)
})

test('an assistant with displayBlocks keeps its pending body and paints no settled figure', () => {
  const publication = chartPublication()
  const message = {
    kind: 'assistant',
    turn: 1,
    text: 'live',
    displayBlocks: [
      { kind: 'content', block: textBlock('Live text ') },
      { kind: 'open-opaque', blockType: 'image' },
    ],
  } as unknown as Extract<TranscriptMessage, { kind: 'assistant' }>
  present(message, [publication])
  const card = cardOf(message)

  assert.equal(figureNodes(card).length, 0)
  assert.equal(copyButtons(card).length, 0)
  assert.equal(nodesOfKind(card, 'image').length, 0)
  assert.equal(mdTexts(card)[0], 'Live text ')
  assert.equal(nodesOfKind(card, 'text').some(node => String(node.props['text']).includes('Open block')), true)
})

// ── The selected figure's node shape is stable ──────────────────────────────

test('selection changes only the badge text, never the figure or button keys', () => {
  const chart = chartPublication()
  const message = assistantRow(`${marker(chart.ref)}`)
  present(message, [chart])
  const plain = cardOf(message)
  const selected = cardOf(message, { selectedVisual: { ref: chart.ref, index: 1, count: 2 } })

  const keys = (card: Node): unknown[] => [
    ...figureKeys(card),
    ...copyButtons(card).map(button => button.props['key']),
    ...nodesOfKind(card, 'image').map(node => node.props['key']),
  ]
  assert.deepEqual(keys(plain), keys(selected))
  assert.deepEqual(nodesOfKind(plain, 'badge'), [])
  assert.deepEqual(nodesOfKind(selected, 'badge').map(badge => badge.props['text']), ['Selected · 1/2'])
})

// ── Duplicate declarations and forged markers ──────────────────────────────

test('a duplicated publication entry paints exactly one figure and one Copy control', () => {
  const publication = chartPublication()
  const message = assistantRow(`${marker(publication.ref)}`)
  present(message, [publication, publication])
  const card = cardOf(message)

  assert.equal(figureNodes(card).length, 1)
  assert.equal(copyButtons(card).length, 1)
})

test('a marker with a non-<#> destination or an escaped line stays text and never becomes a figure', () => {
  const published = svgPublication()
  const forgedHref = `[dsh-visual-${REF_CHART}]: <https://example.com/not-a-marker>`
  const escaped = `\\[dsh-visual-${REF_THIRD}]: <#>`
  const message = assistantRow(`${forgedHref}\n\n${escaped}\n\nTail`)
  present(message, [published])
  const card = cardOf(message)

  // Only the published SVG is tailed; the forged lines keep their bytes.
  assert.deepEqual(figureKeys(card), [`body-visual-${published.ref}`])
  const runs = mdTexts(card).join('')
  assert.equal(runs.includes(forgedHref), true)
  assert.equal(runs.includes(escaped), true)
})

// ── Markdown semantics across the figure split ─────────────────────────────

test('a list, fence, bold/code and raw footnote text keep their exact source across the figure', () => {
  const publication = chartPublication()
  const before = '## Heading\n\n- item one\n- item two\n\n```\nconst x = 1\n```\n\n**bold** and `code`, a [doc][ref] and footnote[^1].\n\n'
  const after = '\n\n> quote after\n\n[^1]: the footnote text.\n\n[ref]: https://example.com/x'
  const linkDefinition = '[ref]: https://example.com/x\n\n'
  const message = assistantRow(`${before}${marker(publication.ref)}${after}`)
  present(message, [publication])
  const card = cardOf(message)
  const runs = mdTexts(card)

  assert.equal(figureNodes(card).length, 1)
  assert.equal(runs.length, 2)
  // The ordinary link definition is re-supplied to BOTH runs. The pinned Tern
  // client does not implement footnote syntax (it paints `[^1]` literally), so
  // the footnote definition is ordinary tail text and must survive byte-exact
  // instead of being promoted into a display-only definition prefix.
  assert.equal(runs[0], `${linkDefinition}${before}`)
  assert.equal(runs[1], `${linkDefinition}${after}`)
  assert.equal(runs[1].includes('[^1]: the footnote text.'), true)
  assert.equal(runs.join('').includes('dsh-visual-'), false)
})
