/**
 * PR3: the mounted TSP session's published-visual Copy paths and selection.
 *
 * The chain under test is the PRODUCTION one:
 *
 *     a real mounted TSP renderer (`mountTspRenderer`) over the shipped SDK
 *       -> the committed Assistant frame the mapper builds
 *       -> the REAL current-frame Copy-target index (real node ids)
 *       -> pointer `action` admission / the Alt+V + Alt+C chord path
 *       -> the injected Client-local clipboard callback (exactly once)
 *       -> the REAL `session.blob()` for an admitted SVG, and the SDK wire
 *
 * STANDS-IN (never claimed as production): the pane is a scripted tty (not a
 * real Tern client), the `PublishedVisual[]` are qualified-fact fixtures and
 * the clipboard callback is a recorder. The REAL PR1/PR2 derivation and the
 * real ClientActions clipboard are qualified by the integration suites; the
 * real-pane presentation is a separate lane.
 * @module @xmoon76/dsh-pi-tui/app/tern-tsp-visual-assistant-actions.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { connect as sdkConnect } from '@stencil-hq/tern'
import type { Op, TermInput, TermOutput } from '@stencil-hq/tern'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'
import type { ChartFact } from '../../src/domain/visual/chart.ts'
import { svgDigest, svgHumanText, type SvgFact } from '../../src/domain/visual/svg.ts'
import { SVG_TOOL_NAME } from '../../src/domain/visual/tools.ts'
import { setAssistantVisualPresentation } from '../../src/domain/visual/presentation.ts'
import { mountTspRenderer, type TspInputHandlers, type TspRenderer } from '../../src/tui/tsp/session.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

// ── The scripted Tern pane ──────────────────────────────────────────────────

class FakeInput extends EventEmitter implements TermInput {
  readonly isTTY = true
  isRaw = false
  setRawMode(mode: boolean): void {
    this.isRaw = mode
  }
  type(text: string): void {
    this.emit('data', ENCODER.encode(text))
  }
}

class FakeOutput implements TermOutput {
  readonly isTTY = true
  readonly columns = 100
  readonly chunks: Uint8Array[] = []
  onWrite: ((bytes: Uint8Array) => void) | undefined
  write(data: Uint8Array | string): boolean {
    const bytes = typeof data === 'string' ? ENCODER.encode(data) : data
    this.chunks.push(bytes)
    this.onWrite?.(bytes)
    return true
  }
}

const HELLO = {
  r: 'hello',
  v: 1,
  term: 'tern',
  ver: '0.9.5',
  kinds: ['col', 'row', 'card', 'section', 'md', 'code', 'badge', 'tool', 'text', 'image', 'chart', 'picker', 'overlay'],
  features: ['flow', 'styles', 'blobs'],
  apc: 65536,
  credits: 4,
  cols: 120,
  cell: { w: 8, h: 17 },
  dark: true,
  reduceMotion: false,
  hour12: false,
}

interface WireFrame {
  readonly sf: string
  readonly s: number
  readonly ops: readonly Op[]
}

type WireEvent =
  | { readonly kind: 'blob'; readonly id: string; readonly mime: string | undefined }
  | { readonly kind: 'sheet'; readonly name: string; readonly css: string | undefined }
  | { readonly kind: 'frame'; readonly frame: WireFrame }

class ScriptedTern {
  readonly input = new FakeInput()
  readonly output = new FakeOutput()
  readonly events: WireEvent[] = []

  constructor(hello: typeof HELLO = HELLO, options: { readonly failBlobWrite?: boolean } = {}) {
    this.output.onWrite = bytes => {
      const text = DECODER.decode(bytes)
      if (options.failBlobWrite === true && text.includes('\u001b_tsp;b;')) {
        throw new Error('the tty owner is gone')
      }
      if (text.includes('\u001b[c')) {
        setTimeout(() => this.input.type(`\u001b_tsp;r;${JSON.stringify(hello)}\u001b\\\u001b[?62;52;c`), 1)
        return
      }
      for (const match of text.matchAll(/\u001b_tsp;b;id=([0-9a-f]+);(?:mime=([^;]+);)?/g)) {
        this.events.push({ kind: 'blob', id: match[1] as string, mime: match[2] })
      }
      for (const match of text.matchAll(/\u001b_tsp;s;([\s\S]*?)\u001b\\/g)) {
        const body = JSON.parse(match[1] as string) as { name?: string; css?: string }
        if (body.name !== undefined) this.events.push({ kind: 'sheet', name: body.name, css: body.css })
      }
      for (const match of text.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
        const frame = JSON.parse(match[1] as string) as WireFrame
        this.events.push({ kind: 'frame', frame })
        setTimeout(() => this.input.type(
          `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
        ), 0)
      }
    }
  }

  frames(): WireFrame[] {
    return this.events.flatMap(event => event.kind === 'frame' ? [event.frame] : [])
  }

  sheets(): { name: string; css: string | undefined }[] {
    return this.events.flatMap(event => event.kind === 'sheet' ? [{ name: event.name, css: event.css }] : [])
  }

  blobs(): { id: string; mime: string | undefined }[] {
    return this.events.flatMap(event => event.kind === 'blob' ? [{ id: event.id, mime: event.mime }] : [])
  }

  /** Deliver one native pane event through the SDK's own event channel. */
  event(value: unknown): void {
    this.input.type(`\u001b_tsp;e;${JSON.stringify(value)}\u001b\\`)
  }
}

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

function marker(ref: string): string {
  return `[dsh-visual-${ref}]: <#>`
}

function chartPublication(): PublishedVisual {
  return {
    ref: REF_CHART,
    turn: 1,
    step: 0,
    stepStartSeq: 20,
    callSeq: 21,
    resultSeq: 22,
    callId: 'present-chart',
    source: {
      ref: REF_CHART,
      type: 'chart',
      title: CHART.title,
      turn: 1,
      step: 0,
      stepStartSeq: 10,
      callSeq: 11,
      resultSeq: 12,
      callId: 'call-chart',
      chart: CHART,
      svg: undefined,
      svgSource: undefined,
      svgAdmissionWidth: undefined,
    },
  }
}

function svgPublication(): PublishedVisual {
  return {
    ref: REF_SVG,
    turn: 1,
    step: 0,
    stepStartSeq: 20,
    callSeq: 21,
    resultSeq: 22,
    callId: 'present-svg',
    source: {
      ref: REF_SVG,
      type: 'svg',
      title: SVG.title,
      turn: 1,
      step: 0,
      stepStartSeq: 10,
      callSeq: 11,
      resultSeq: 12,
      callId: 'call-svg',
      chart: undefined,
      svg: SVG,
      svgSource: SVG_SOURCE,
      svgAdmissionWidth: 640,
    },
  }
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text } as ContentBlock
}

function assistantRow(text: string, content?: readonly ContentBlock[]): Extract<TranscriptMessage, { kind: 'assistant' }> {
  return { kind: 'assistant', turn: 1, text, ...(content === undefined ? {} : { content }) }
}

/** Attach the PR2 display sidecar to the exact row. */
function present(message: TranscriptMessage, publications: readonly PublishedVisual[]): void {
  setAssistantVisualPresentation(message, {
    subjectKind: 'main',
    subjectId: 'session-1',
    sourceIdentity: {},
    session: {},
    sessionId: 'session-1',
    seq: 1,
    turn: 1,
    step: 0,
    text: 'text' in message ? message.text : '',
    content: 'content' in message ? message.content : undefined,
    assistantRevision: 0,
  }, publications)
}

// ── The pane tree and the harness ──────────────────────────────────────────

interface LiveNode {
  readonly id: string
  readonly kind: string
  readonly props: Record<string, unknown>
  readonly children: LiveNode[]
}

/** The pane's CURRENT tree, rebuilt by applying the SDK's ordered ops. */
function currentNodes(tern: ScriptedTern): LiveNode[] {
  const live = new Map<string, LiveNode>()
  const insert = (node: { id?: string; k?: string; p?: Record<string, unknown>; c?: readonly unknown[] }, parentId: string | undefined): void => {
    if (typeof node.id !== 'string') return
    const entry: LiveNode = { id: node.id, kind: node.k ?? '', props: { ...(node.p ?? {}) }, children: [] }
    live.set(node.id, entry)
    if (parentId !== undefined) live.get(parentId)?.children.push(entry)
    for (const child of node.c ?? []) insert(child as never, node.id)
  }
  const remove = (id: string): void => {
    const node = live.get(id)
    if (node === undefined) return
    for (const child of [...node.children]) remove(child.id)
    live.delete(id)
  }
  for (const frame of tern.frames()) {
    for (const op of frame.ops) {
      if (op[0] === 'add') insert(op[4] as never, op[2] as string | undefined)
      else if (op[0] === 'set') {
        const node = live.get(op[1] as string)
        if (node !== undefined) Object.assign(node.props, op[2] as Record<string, unknown>)
      } else if (op[0] === 'text') {
        const node = live.get(op[1] as string)
        if (node === undefined) continue
        node.props.text = op[2] === 'append'
          ? `${String(node.props.text ?? '')}${String(op[3])}`
          : String(op[3])
      } else if (op[0] === 'del') remove(op[1] as string)
    }
  }
  return [...live.values()]
}

function nodesWhere(tern: ScriptedTern, predicate: (node: LiveNode) => boolean): LiveNode[] {
  return currentNodes(tern).filter(predicate)
}

function copyButtonIds(tern: ScriptedTern): string[] {
  return nodesWhere(tern, node => node.kind === 'el' && node.props['role'] === 'dsh.visual.copy')
    .map(node => node.id)
}

function badgeTexts(tern: ScriptedTern): string[] {
  return nodesWhere(tern, node => node.kind === 'badge' && typeof node.props['text'] === 'string')
    .map(node => String(node.props['text']))
}

function textNodes(tern: ScriptedTern): string[] {
  return nodesWhere(tern, node => node.kind === 'text' && typeof node.props['text'] === 'string')
    .map(node => String(node.props['text']))
}

function codeTexts(tern: ScriptedTern): string[] {
  return nodesWhere(tern, node => node.kind === 'code' && typeof node.props['text'] === 'string')
    .map(node => String(node.props['text']))
}

function figureIds(tern: ScriptedTern): string[] {
  return nodesWhere(tern, node => node.kind === 'col' && node.props['role'] === 'dsh.visual.figure')
    .map(node => node.id)
}

function surfaceId(tern: ScriptedTern): string {
  const frame = tern.frames()[0]
  assert.ok(frame !== undefined, 'the mounted renderer drew at least one frame')
  return frame.sf
}

/** Wait for an AUTHORITATIVE wire fact, never for elapsed time. */
async function until(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

interface CopyCall {
  readonly text: string
}

interface Harness {
  readonly renderer: TspRenderer
  readonly tern: ScriptedTern
  readonly copies: CopyCall[]
  readonly fatalErrors: unknown[]
  readonly logErrors: { message: string; fields?: Record<string, unknown> }[]
  /** Make the next clipboard writes settle with this controller. */
  nextCopy(): { readonly promise: Promise<boolean>; resolve(value: boolean): void; reject(error: unknown): void }
  setCopyOutcome(outcome: 'success' | 'false' | 'reject'): void
  commit(messages: readonly TranscriptMessage[], source: object): void
  dispose(): Promise<void>
}

async function mountHarness(options: {
  readonly hello?: typeof HELLO
  readonly failBlobWrite?: boolean
  /** Bind the input handlers (default true). A false case models the pre-bind
   *  window, where no application intent may run yet. */
  readonly bind?: boolean
} = {}): Promise<Harness> {
  const tern = new ScriptedTern(options.hello ?? HELLO, { failBlobWrite: options.failBlobWrite })
  const session = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  const copies: CopyCall[] = []
  const fatalErrors: unknown[] = []
  const logErrors: { message: string; fields?: Record<string, unknown> }[] = []
  let outcome: 'success' | 'false' | 'reject' = 'success'
  let pending: { promise: Promise<boolean>; resolve(value: boolean): void; reject(error: unknown): void } | undefined
  const renderer = mountTspRenderer(session, {
    requestExit: () => {},
    onFatal: (error) => { fatalErrors.push(error) },
    logError: (message, fields) => { logErrors.push({ message, ...(fields === undefined ? {} : { fields }) }) },
    copyVisual: (text) => {
      copies.push({ text })
      if (pending !== undefined) {
        const next = pending
        pending = undefined
        return next.promise
      }
      if (outcome === 'reject') return Promise.reject(new Error('clipboard refused'))
      return Promise.resolve(outcome === 'success')
    },
  })
  const handlers: TspInputHandlers = {
    exit: () => {},
    cancel: () => {},
    submit: () => {},
    steer: () => {},
    pasteMedia: () => {},
    noteUserInput: () => {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
  }
  if (options.bind !== false) renderer.bindInput(handlers)
  return {
    renderer,
    tern,
    copies,
    fatalErrors,
    logErrors,
    nextCopy() {
      const deferred = Promise.withResolvers<boolean>()
      pending = { promise: deferred.promise, resolve: deferred.resolve, reject: deferred.reject }
      return pending
    },
    setCopyOutcome(next: 'success' | 'false' | 'reject') {
      outcome = next
    },
    commit(messages, source) {
      renderer.display.setTranscript(messages, undefined, undefined, undefined, undefined, source)
    },
    dispose: () => renderer.dispose(),
  }
}

/** One answer that carries a chart and an SVG at their markers. */
function bothFiguresAnswer(): { readonly messages: readonly TranscriptMessage[]; readonly chart: PublishedVisual; readonly svg: PublishedVisual } {
  const chart = chartPublication()
  const svg = svgPublication()
  const message = assistantRow(`Latency:\n\n${marker(chart.ref)}\n\nThen:\n\n${marker(svg.ref)}\n\nDone.`)
  present(message, [chart, svg])
  return { messages: [message], chart, svg }
}

// ── Pointer Copy ────────────────────────────────────────────────────────────

test('a pointer Copy Data copies the exact final chart fact once', async () => {
  const harness = await mountHarness()
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    const [chartButton] = copyButtonIds(harness.tern)
    assert.ok(chartButton !== undefined, 'the chart figure painted its Copy control')

    harness.tern.event({ ev: 'action', sf: surfaceId(harness.tern), id: chartButton, act: 'dsh-visual-copy' })
    await until('the clipboard write', () => harness.copies.length === 1)
    assert.deepEqual(harness.copies, [{ text: JSON.stringify(CHART, null, 2) }])
    await until('the success notice', () => textNodes(harness.tern).includes('Copied chart data'))
  } finally {
    await harness.dispose()
  }
})

test('a pointer Copy SVG copies the raw admitted source and sends one image/svg+xml blob', async () => {
  const harness = await mountHarness()
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    const buttons = copyButtonIds(harness.tern)
    assert.equal(buttons.length, 2, 'both figures painted a Copy control')
    const svgButton = buttons[1] as string

    // The native image is display demand: exactly one blob, of the admitted SVG.
    await until('the SVG blob', () => harness.tern.blobs().length === 1)
    assert.equal(harness.tern.blobs()[0]?.mime, 'image/svg+xml')

    harness.tern.event({ ev: 'action', sf: surfaceId(harness.tern), id: svgButton, act: 'dsh-visual-copy' })
    await until('the clipboard write', () => harness.copies.length === 1)
    assert.equal(harness.copies[0]?.text, SVG_SOURCE, 'the raw source is copied with no trimming')
    await until('the success notice', () => textNodes(harness.tern).includes('Copied SVG source'))
  } finally {
    await harness.dispose()
  }
})

test('one action performs exactly one clipboard call, even with two figures present', async () => {
  const harness = await mountHarness()
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    const [chartButton] = copyButtonIds(harness.tern)
    harness.tern.event({ ev: 'action', sf: surfaceId(harness.tern), id: chartButton, act: 'dsh-visual-copy' })
    await until('the clipboard write', () => harness.copies.length === 1)
    harness.tern.event({ ev: 'action', sf: surfaceId(harness.tern), id: chartButton, act: 'dsh-visual-copy' })
    await until('the second clipboard write', () => harness.copies.length === 2)
    assert.deepEqual(harness.copies, [
      { text: JSON.stringify(CHART, null, 2) },
      { text: JSON.stringify(CHART, null, 2) },
    ])
  } finally {
    await harness.dispose()
  }
})

// ── Keyboard selection and copy ─────────────────────────────────────────────

test('Alt+V selects the first figure, reveals it, then cycles and wraps', async () => {
  const harness = await mountHarness()
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    const figures = figureIds(harness.tern)
    assert.equal(figures.length, 2)

    harness.tern.input.type('\u001bv')
    await until('the first selection badge', () => badgeTexts(harness.tern).includes('Selected · 1/2'))
    const firstReveal = harness.tern.frames().flatMap(frame => frame.ops).find(op => op[0] === 'reveal')
    assert.deepEqual(firstReveal, ['reveal', figures[0], 'nearest'])

    harness.tern.input.type('\u001bv')
    await until('the second selection badge', () => badgeTexts(harness.tern).includes('Selected · 2/2'))
    harness.tern.input.type('\u001bv')
    await until('the wrapped selection badge', () => badgeTexts(harness.tern).filter(text => text === 'Selected · 1/2').length === 1)
  } finally {
    await harness.dispose()
  }
})

test('Alt+C with no selection prompts instead of guessing a figure', async () => {
  const harness = await mountHarness()
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    harness.tern.input.type('\u001bc')
    await until('the selection prompt', () => textNodes(harness.tern).includes('Alt+V to select a visual'))
    assert.equal(harness.copies.length, 0)
  } finally {
    await harness.dispose()
  }
})

test('Alt+C copies the selected figure and leaves the composer draft untouched', async () => {
  const harness = await mountHarness()
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    harness.renderer.composer.setDraft('unfinished draft')
    harness.tern.input.type('\u001bv')
    await until('the first selection badge', () => badgeTexts(harness.tern).includes('Selected · 1/2'))
    harness.tern.input.type('\u001bc')
    await until('the clipboard write', () => harness.copies.length === 1)
    assert.equal(harness.copies[0]?.text, JSON.stringify(CHART, null, 2))
    assert.equal(harness.renderer.composer.getDraft(), 'unfinished draft')
    await until('the success notice', () => textNodes(harness.tern).includes('Copied chart data'))
  } finally {
    await harness.dispose()
  }
})

test('a second Alt+C copies the newer selection, never the earlier figure', async () => {
  const harness = await mountHarness()
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    harness.tern.input.type('\u001bv')
    await until('the first selection badge', () => badgeTexts(harness.tern).includes('Selected · 1/2'))
    harness.tern.input.type('\u001bc')
    await until('the chart copy', () => harness.copies.length === 1)
    harness.tern.input.type('\u001bv')
    await until('the second selection badge', () => badgeTexts(harness.tern).includes('Selected · 2/2'))
    harness.tern.input.type('\u001bc')
    await until('the SVG copy', () => harness.copies.length === 2)
    assert.equal(harness.copies[1]?.text, SVG_SOURCE)
  } finally {
    await harness.dispose()
  }
})

// ── Currentness: old frame ids, new subjects, in-flight copies ──────────────

test('a Copy action from an older frame is refused after the subject scope changes', async () => {
  const harness = await mountHarness()
  try {
    const first = bothFiguresAnswer()
    harness.commit(first.messages, {})
    const oldButton = copyButtonIds(harness.tern)[0] as string

    const second = bothFiguresAnswer()
    harness.commit(second.messages, {})
    const newButton = copyButtonIds(harness.tern)[0] as string
    assert.notEqual(newButton, oldButton, 'the new scope renames the whole node tree')

    harness.tern.event({ ev: 'action', sf: surfaceId(harness.tern), id: oldButton, act: 'dsh-visual-copy' })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(harness.copies.length, 0, 'a stale frame id never copies')
  } finally {
    await harness.dispose()
  }
})

test('a same-ref figure in a new session does not inherit the old selection or button id', async () => {
  const harness = await mountHarness()
  try {
    const first = bothFiguresAnswer()
    harness.commit(first.messages, {})
    harness.tern.input.type('\u001bv')
    await until('the first selection badge', () => badgeTexts(harness.tern).includes('Selected · 1/2'))
    const oldButton = copyButtonIds(harness.tern)[0] as string

    const second = bothFiguresAnswer()
    harness.commit(second.messages, {})
    assert.deepEqual(badgeTexts(harness.tern).filter(text => text.startsWith('Selected ·')), [],
      'the new subject starts with no selected figure')
    harness.tern.input.type('\u001bc')
    await until('the selection prompt', () => textNodes(harness.tern).includes('Alt+V to select a visual'))
    harness.tern.event({ ev: 'action', sf: surfaceId(harness.tern), id: oldButton, act: 'dsh-visual-copy' })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(harness.copies.length, 0)
  } finally {
    await harness.dispose()
  }
})

test('an in-flight copy settled after a subject switch writes no notice to the new subject', async () => {
  const harness = await mountHarness()
  try {
    const first = bothFiguresAnswer()
    harness.commit(first.messages, {})
    const chartButton = copyButtonIds(harness.tern)[0] as string
    const inflight = harness.nextCopy()
    harness.tern.event({ ev: 'action', sf: surfaceId(harness.tern), id: chartButton, act: 'dsh-visual-copy' })
    await until('the clipboard call', () => harness.copies.length === 1)

    // The answer (with the SAME refs) is committed under a NEW source scope
    // while the clipboard write is still pending.
    harness.commit(bothFiguresAnswer().messages, {})
    const noticesBefore = textNodes(harness.tern).filter(text => text.startsWith('Copied ') || text.startsWith('Failed to copy '))
    inflight.resolve(true)
    await new Promise(resolve => setTimeout(resolve, 50))
    const noticesAfter = textNodes(harness.tern).filter(text => text.startsWith('Copied ') || text.startsWith('Failed to copy '))
    assert.deepEqual(noticesAfter, noticesBefore, 'the old request never notifies the new subject')
    assert.deepEqual(harness.copies, [{ text: JSON.stringify(CHART, null, 2) }],
      'the payload was snapshotted at admission, never re-read after the switch')
  } finally {
    await harness.dispose()
  }
})

// ── Owners that outrank the visual chords ──────────────────────────────────

test('an open Work Hub refuses pointer Copy and both chords', async () => {
  const harness = await mountHarness()
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    const button = copyButtonIds(harness.tern)[0] as string
    const handle = harness.renderer.taskPresentation.openBrowser([
      { value: 'job:1', label: 'Job one', status: 'running', source: 'job' },
    ], () => 'keep-open', () => {}, {
      header: 'Work',
      mode: 'full',
      openedFrom: 'command',
      scope: 'all',
      enableSearch: true,
      expandedIds: [],
      collapsedIds: [],
      maxVisible: 8,
      loading: false,
      groupLabels: true,
      onRefresh: () => {},
      onStop: () => {},
      onViewportExpose: () => {},
      onRetired: () => {},
    })
    await until('the Work Hub layer', () => nodesWhere(harness.tern, node => node.kind === 'picker').length > 0)

    harness.tern.event({ ev: 'action', sf: surfaceId(harness.tern), id: button, act: 'dsh-visual-copy' })
    harness.tern.input.type('\u001bv')
    harness.tern.input.type('\u001bc')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(harness.copies.length, 0)
    assert.deepEqual(badgeTexts(harness.tern).filter(text => text.startsWith('Selected ·')), [])
    handle.close()
  } finally {
    await harness.dispose()
  }
})

test('a hydration window refuses pointer Copy and changes neither the draft nor the selection', async () => {
  const harness = await mountHarness()
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    const button = copyButtonIds(harness.tern)[0] as string
    harness.renderer.display.beginSessionHydration()
    harness.tern.event({ ev: 'action', sf: surfaceId(harness.tern), id: button, act: 'dsh-visual-copy' })
    harness.tern.input.type('\u001bv')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(harness.copies.length, 0)
    assert.deepEqual(badgeTexts(harness.tern).filter(text => text.startsWith('Selected ·')), [])
  } finally {
    await harness.dispose()
  }
})

// ── Copy outcomes and blob failures ────────────────────────────────────────

test('a failed clipboard write reports the failure and never claims a copy', async () => {
  const harness = await mountHarness()
  try {
    harness.setCopyOutcome('false')
    harness.commit(bothFiguresAnswer().messages, {})
    harness.tern.input.type('\u001bv')
    await until('the first selection badge', () => badgeTexts(harness.tern).includes('Selected · 1/2'))
    harness.tern.input.type('\u001bc')
    await until('the failure notice', () => textNodes(harness.tern).includes('! Failed to copy chart data'))
    assert.equal(textNodes(harness.tern).includes('Copied chart data'), false)
  } finally {
    await harness.dispose()
  }
})

test('a rejected clipboard write routes through the existing error owner without leaking the payload', async () => {
  const harness = await mountHarness()
  try {
    harness.setCopyOutcome('reject')
    harness.commit(bothFiguresAnswer().messages, {})
    harness.tern.input.type('\u001bv')
    await until('the first selection badge', () => badgeTexts(harness.tern).includes('Selected · 1/2'))
    harness.tern.input.type('\u001bc')
    await until('the failure notice', () => textNodes(harness.tern).includes('! Failed to copy chart data'))
    const recorded = JSON.stringify(harness.logErrors)
    assert.equal(recorded.includes('p50'), false, 'the diagnostics never carry the copied payload')
    assert.equal(recorded.includes('clipboard refused'), true, 'the failure itself is recorded')
  } finally {
    await harness.dispose()
  }
})

test('a fatal SVG blob failure aborts the frame instead of painting a fake image', async () => {
  const harness = await mountHarness({ failBlobWrite: true })
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    await until('the fatal route', () => harness.fatalErrors.length === 1)
    assert.equal(nodesWhere(harness.tern, node => node.kind === 'image').length, 0,
      'no image node references a blob that was never sent')
    assert.equal(harness.tern.blobs().length, 0)
  } finally {
    await harness.dispose()
  }
})

// ── Additional owner/negative coverage ─────────────────────────────────────

test('an unbound renderer refuses both the pointer action and the chords', async () => {
  const harness = await mountHarness({ bind: false })
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    const button = copyButtonIds(harness.tern)[0] as string
    harness.tern.event({ ev: 'action', sf: surfaceId(harness.tern), id: button, act: 'dsh-visual-copy' })
    harness.tern.input.type('\u001bv')
    harness.tern.input.type('\u001bc')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(harness.copies.length, 0, 'no pre-bind application intent may run')
    assert.deepEqual(badgeTexts(harness.tern).filter(text => text.startsWith('Selected ·')), [])
  } finally {
    await harness.dispose()
  }
})

test('switching A -> B -> A clears the old selection and every old Copy id', async () => {
  const harness = await mountHarness()
  try {
    const first = bothFiguresAnswer()
    harness.commit(first.messages, {})
    harness.tern.input.type('\u001bv')
    await until('the first selection badge', () => badgeTexts(harness.tern).includes('Selected · 1/2'))
    const firstButton = copyButtonIds(harness.tern)[0] as string

    harness.commit(bothFiguresAnswer().messages, {})
    harness.commit(bothFiguresAnswer().messages, {})
    assert.deepEqual(badgeTexts(harness.tern).filter(text => text.startsWith('Selected ·')), [],
      'the returned subject starts with no inherited selection')
    const currentButton = copyButtonIds(harness.tern)[0] as string
    assert.notEqual(currentButton, firstButton)
    harness.tern.event({ ev: 'action', sf: surfaceId(harness.tern), id: firstButton, act: 'dsh-visual-copy' })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(harness.copies.length, 0)
    harness.tern.input.type('\u001bc')
    await until('the selection prompt', () => textNodes(harness.tern).includes('Alt+V to select a visual'))
  } finally {
    await harness.dispose()
  }
})

test('a pane without the styles feature installs no visual sheet and still copies', async () => {
  const withoutStyles = { ...HELLO, features: HELLO.features.filter(feature => feature !== 'styles') }
  const harness = await mountHarness({ hello: withoutStyles })
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    assert.equal(harness.tern.sheets().some(sheet => sheet.name === 'dsh-visual-copy'), false)
    const button = copyButtonIds(harness.tern)[0] as string
    assert.ok(button !== undefined)
    harness.tern.event({ ev: 'action', sf: surfaceId(harness.tern), id: button, act: 'dsh-visual-copy' })
    await until('the clipboard write', () => harness.copies.length === 1)
    assert.deepEqual(harness.copies, [{ text: JSON.stringify(CHART, null, 2) }])
  } finally {
    await harness.dispose()
  }
})

/** The real SVG tool row whose credential matches the given admitted source. */
function svgToolRow(source: string): TranscriptMessage {
  const fact = {
    version: 1 as const,
    type: 'svg' as const,
    title: SVG.title,
    description: SVG.description,
    digest: svgDigest(source),
    bytes: Buffer.byteLength(source, 'utf8'),
  }
  return {
    kind: 'tool',
    turn: 1,
    name: SVG_TOOL_NAME,
    args: JSON.stringify({ title: SVG.title, description: SVG.description, svg: source }),
    result: svgHumanText(fact),
    status: 'ok',
    resultBlocks: [
      { type: 'text', text: svgHumanText(fact) },
      { type: 'text', text: `visual-v1:${JSON.stringify(fact)}` },
    ],
  } as unknown as TranscriptMessage
}

/** The same admitted SVG published into the Assistant body. */
function svgPublicationFor(source: string): PublishedVisual {
  const publication = svgPublication()
  return {
    ...publication,
    source: {
      ...publication.source,
      svg: {
        ...(publication.source.svg as SvgFact),
        digest: svgDigest(source),
        bytes: Buffer.byteLength(source, 'utf8'),
      },
      svgSource: source,
    },
  }
}

test('a Tool SVG and the Assistant image of the same source share ONE sent blob, even after expansion', async () => {
  const harness = await mountHarness()
  try {
    const tool = svgToolRow(SVG_SOURCE)
    const publication = svgPublicationFor(SVG_SOURCE)
    const answer = assistantRow(`SVG:\n\n${marker(publication.ref)}`)
    present(answer, [publication])
    harness.commit([answer, tool], {})

    await until('the assistant SVG blob', () => harness.tern.blobs().length === 1)
    assert.equal(nodesWhere(harness.tern, node => node.kind === 'image').length, 1,
      'the collapsed Tool card draws no image; the Assistant figure draws one')
    assert.equal(harness.tern.sheets().some(sheet => sheet.name === 'dsh-visual-copy'), true)

    const toolNode = nodesWhere(harness.tern, node => node.kind === 'tool')[0]
    assert.ok(toolNode !== undefined)
    harness.tern.event({ ev: 'toggle', sf: surfaceId(harness.tern), id: toolNode.id, collapsed: false })
    await until('the expanded Tool SVG image', () => nodesWhere(harness.tern, node => node.kind === 'image').length === 2)
    assert.equal(harness.tern.blobs().length, 1,
      'expanding the Tool card reuses the content-addressed blob id instead of re-sending bytes')
  } finally {
    await harness.dispose()
  }
})

// ── Capability fallbacks ────────────────────────────────────────────────────

test('a pane without the chart kind paints exact chart values and never a chart node', async () => {
  const withoutChart = { ...HELLO, kinds: HELLO.kinds.filter(kind => kind !== 'chart') }
  const harness = await mountHarness({ hello: withoutChart })
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    assert.equal(nodesWhere(harness.tern, node => node.kind === 'chart').length, 0)
    assert.equal(codeTexts(harness.tern).some(text => text.includes('p50  42 ms')), true)
    // The Copy control is NOT a native-drawing capability: it stays usable.
    assert.equal(copyButtonIds(harness.tern).length, 2)
  } finally {
    await harness.dispose()
  }
})

test('a pane with the image kind but no blobs feature sends no SVG blob and keeps the description', async () => {
  const withoutBlobs = { ...HELLO, features: HELLO.features.filter(feature => feature !== 'blobs') }
  const harness = await mountHarness({ hello: withoutBlobs })
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    assert.equal(harness.tern.blobs().length, 0)
    assert.equal(nodesWhere(harness.tern, node => node.kind === 'image').length, 0)
    assert.equal(codeTexts(harness.tern).some(text => text.includes('Gateway to database')), true)
  } finally {
    await harness.dispose()
  }
})

test('no figure means no SVG blob and no visual action hint in the dock', async () => {
  const harness = await mountHarness()
  try {
    const message = assistantRow('Plain answer.')
    harness.commit([message], {})
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(harness.tern.blobs().length, 0)
    assert.equal(textNodes(harness.tern).includes('Alt+V select visual · Alt+C copy'), false)
  } finally {
    await harness.dispose()
  }
})

test('the visual action hint appears exactly while a figure is in the current window', async () => {
  const harness = await mountHarness()
  try {
    harness.commit(bothFiguresAnswer().messages, {})
    await until('the action hint', () => textNodes(harness.tern).includes('Alt+V select visual · Alt+C copy'))
  } finally {
    await harness.dispose()
  }
})
