/**
 * PR-D: the REAL Direct runner + TSP renderer carrying the two visual tool
 * results over the scripted pane wire.
 *
 * The model is a fixture adapter and the pane is a scripted tty (standing-in,
 * never claimed as a physical Tern GUI). The chain under test is the
 * production one: real durable `tool/call`/`tool/result` events → the ONE
 * TranscriptFolder → the production TSP mapper → the ONE SDK blob sender /
 * `surface.render()` → the wire.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-visual-result.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createDirectTspFixture, waitFor } from '../support/direct-tsp-fixture.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TspWireFrame } from '../support/tsp-terminal-fixture.ts'
import { chartContentBlocks, chartFactFromArgs } from '../../src/domain/visual/chart.ts'
import { svgContentBlocks, svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import { TranscriptNodeKeys, transcriptView } from '../../src/tui/tsp/transcript-view.ts'

const SESSION_ID = 'prd-visual-session'

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/>'
  + '<text x="4" y="20" font-size="12" fill="#ffffff">Gateway</text></svg>'

interface WireNodeLike {
  readonly k?: string
  readonly id?: string
  readonly p?: Record<string, unknown>
  readonly c?: readonly WireNodeLike[]
}

function wireNodes(frames: readonly TspWireFrame[]): WireNodeLike[] {
  const out: WireNodeLike[] = []
  const walk = (node: WireNodeLike): void => {
    out.push(node)
    for (const child of node.c ?? []) walk(child)
  }
  for (const frame of frames) {
    for (const op of frame.ops) {
      if (op[0] === 'add') walk(op[4] as unknown as WireNodeLike)
    }
  }
  return out
}

/** Whether a `set` op gave an image node the given blob id. */
function imageCarriesBlob(frames: readonly TspWireFrame[], blobId: string): boolean {
  const imageIds = new Set<string>()
  const walk = (node: WireNodeLike | undefined): void => {
    if (node === undefined) return
    if (node.k === 'image') {
      // A ready blob is serialized on the node itself; the PR-C pending →
      // ready path additionally uses a later `set` op on its id.
      if (typeof node.id === 'string') imageIds.add(node.id)
      if ((node.p as { blob?: string } | undefined)?.blob === blobId) imageIds.add(`blob:${blobId}`)
    }
    for (const child of node.c ?? []) walk(child)
  }
  for (const frame of frames) {
    for (const op of frame.ops) {
      if (op[0] === 'add') walk(op[4] as unknown as WireNodeLike)
      if (op[0] === 'set' && typeof op[1] === 'string' && (op[2] as { blob?: string }).blob === blobId) return true
    }
  }
  return imageIds.has(`blob:${blobId}`)
}

/**
 * PR-D RFL-016: the ready SVG cards start collapsed; expand every projected
 * tool card through the Tern `toggle` event (the actual user display demand).
 */
function expandToolCards(fixture: { readonly pane: { event(value: unknown): void; frames(): readonly TspWireFrame[] } }): void {
  const frames = fixture.pane.frames()
  const sf = frames[frames.length - 1]?.sf
  if (sf === undefined) throw new Error('the pane has no surface frame to address the toggle event')
  for (const node of wireNodes(frames)) {
    if (node.k !== 'tool' || typeof node.id !== 'string') continue
    fixture.pane.event({
      ev: 'toggle',
      sf,
      id: node.id,
      collapsed: false,
      key: node.id.slice(node.id.lastIndexOf('.') + 1),
      raw: {},
    })
  }
}

async function sessionOf(fixture: { readonly ctx: { sessions: { get(id: unknown): unknown } } }): Promise<{
  append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
}> {
  let session: { append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void } | undefined
  await waitFor('the runner to resume the session', () => {
    session = fixture.ctx.sessions.get(SessionId(SESSION_ID)) as never
    return session !== undefined
  }, 30_000)
  return session!
}

function appendTool(fixture: { readonly ctx: { sessions: { get(id: unknown): unknown } } }, callId: string, name: string, args: unknown, blocks: readonly unknown[], isError = false): Promise<void> {
  return sessionOf(fixture).then((session) => {
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 0 })
    session.append('tool/call', {
      turn: 1,
      step: 0,
      callId: ToolCallId(callId),
      name,
      arguments: JSON.stringify(args),
    })
    session.append('tool/result', {
      turn: 1,
      step: 0,
      message: {
        id: MessageId(`result-${callId}`),
        role: 'tool',
        toolCallId: ToolCallId(callId),
        content: blocks,
        isError,
        source: { kind: 'tool', callId: ToolCallId(callId) },
      },
    }, { surfaceOp: 'append' })
  })
}


/**
 * PR-D RFL-014: append one tool row at an EXPLICIT turn/step and close the
 * turn. The fold's authoritative identity is `(turn, step, callId)`; a bare
 * callId is not globally unique and must never key one row's visual state.
 */
async function appendToolAt(
  fixture: { readonly ctx: { sessions: { get(id: unknown): unknown } } },
  turn: number,
  step: number,
  callId: string,
  name: string,
  args: unknown,
  blocks: readonly unknown[],
  isError = false,
): Promise<void> {
  const session = await sessionOf(fixture)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  session.append('tool/call', {
    turn,
    step,
    callId: ToolCallId(callId),
    name,
    arguments: JSON.stringify(args),
  })
  session.append('tool/result', {
    turn,
    step,
    message: {
      id: MessageId(`result-${callId}-${String(turn)}-${String(step)}`),
      role: 'tool',
      toolCallId: ToolCallId(callId),
      content: blocks,
      isError,
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

test('a chart result is painted as a native chart and exact text over the real wire', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['PRD', '-CHART'],
    startup: { sessionId: SESSION_ID },
    persistedBlankSessions: [{ id: SESSION_ID }],
    nativeChart: true,
  })
  try {
    const args = {
      kind: 'bars' as const,
      title: 'Request latency',
      unit: 'ms',
      series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
    }
    const fact = chartFactFromArgs(args)
    await appendTool(fixture, 'call-chart-1', 'dsh_pi_tui_chart', args, chartContentBlocks(fact))
    await waitFor('the wire carries the native chart node', () =>
      wireNodes(fixture.pane.frames()).some(node => node.k === 'chart'), 30_000)
    const nodes = wireNodes(fixture.pane.frames())
    const chart = nodes.find(node => node.k === 'chart')
    assert.ok(chart !== undefined)
    assert.equal(chart.p?.kind, 'bars')
    assert.equal(chart.p?.summary, 'Request latency (ms)')
    assert.deepEqual(chart.p?.series, [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }])
    const text = JSON.stringify(nodes.filter(node => node.k === 'code').map(node => node.p?.text))
    assert.match(text, /p50 {2}42 ms/u, `exact values on the wire: ${text}`)
    assert.doesNotMatch(JSON.stringify(nodes), /visual-v1:/u, 'the machine line is never painted')
  } finally {
    // Bounded teardown window: the fixture disposes the app, pane and Host before the next case.
    await fixture.settle()
  }
})

test('an SVG result is sent as the ONE native blob and painted with its description', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['PRD', '-SVG'],
    startup: { sessionId: SESSION_ID },
    persistedBlankSessions: [{ id: SESSION_ID }],
    nativeImages: true,
  })
  try {
    const args = { title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }
    const fact = svgFactFromArgs(args)
    const expectedBlobId = createHash('sha256').update(Buffer.from(SVG_SOURCE, 'utf8')).digest('hex')
    await appendTool(fixture, 'call-svg-1', 'dsh_pi_tui_svg', args, svgContentBlocks(fact))
    await waitFor('the SVG tool card is projected', () =>
      wireNodes(fixture.pane.frames()).some(node => node.k === 'tool'), 30_000)
    assert.deepEqual(fixture.pane.blobIds(), [], 'a collapsed SVG card sends no blob')
    expandToolCards(fixture)
    await waitFor('the pane received the admitted SVG blob', () =>
      fixture.pane.blobIds().includes(expectedBlobId), 30_000)
    await waitFor('the pane painted the image node with the admitted blob', () =>
      imageCarriesBlob(fixture.pane.frames(), expectedBlobId), 30_000)
    const nodes = wireNodes(fixture.pane.frames())
    assert.equal(nodes.some(node => node.k === 'image'), true, 'a native image node was added')
    const text = JSON.stringify(nodes.filter(node => node.k === 'code').map(node => node.p?.text))
    assert.match(text, /Gateway -> App -> Database/u)
    assert.match(text, /SVG source available/u)
    assert.doesNotMatch(JSON.stringify(nodes), /visual-v1:/u)
  } finally {
    // Bounded teardown window: the fixture disposes the app, pane and Host before the next case.
    await fixture.settle()
  }
})


test('a blocked/error SVG result never sends a blob and keeps the readable text', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['PRD', '-SVG-BLOCKED'],
    startup: { sessionId: SESSION_ID },
    persistedBlankSessions: [{ id: SESSION_ID }],
    nativeImages: true,
  })
  try {
    const args = { title: 'Blocked topology', description: 'Blocked description', svg: SVG_SOURCE }
    const blocks = svgContentBlocks(svgFactFromArgs(args))
    await appendTool(fixture, 'call-svg-blocked', 'dsh_pi_tui_svg', args, blocks, true)
    await waitFor('the pane rendered the blocked description text', () =>
      fixture.pane.output.text().includes('Blocked description'), 30_000)
    assert.deepEqual(fixture.pane.blobIds(), [], 'a blocked result must not send the SVG blob')
    assert.equal(wireNodes(fixture.pane.frames()).some(node => node.k === 'image'), false,
      'a blocked result must not paint a native image')
  } finally {
    // Bounded teardown window: the fixture disposes the app, pane and Host before the next case.
    await fixture.settle()
  }
})


const FIGURE_ONE_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#ef4444"/>'
  + '<text x="4" y="20" font-size="12" fill="#ffffff">One</text></svg>'
const FIGURE_TWO_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/>'
  + '<text x="4" y="20" font-size="12" fill="#ffffff">Two</text></svg>'

function digestOf(source: string): string {
  return createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex')
}

test('a reused callId across turns cannot lend a credential to another SVG row', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['PRD', '-SVG-REUSE-REDACTED'],
    startup: { sessionId: SESSION_ID },
    persistedBlankSessions: [{ id: SESSION_ID }],
    nativeImages: true,
  })
  try {
    const firstArgs = { title: 'Redacted Figure', description: 'redacted figure', svg: FIGURE_ONE_SOURCE }
    const secondArgs = { title: 'Figure 2', description: 'second figure', svg: FIGURE_TWO_SOURCE }
    const secondFact = svgFactFromArgs(secondArgs)
    const firstBlob = digestOf(FIGURE_ONE_SOURCE)
    const secondBlob = digestOf(FIGURE_TWO_SOURCE)
    // The first row's final content is redacted (no machine credential); the
    // second row is a different valid SVG. Both reuse the same bare callId.
    await appendToolAt(fixture, 1, 0, 'reused-call', 'dsh_pi_tui_svg', firstArgs, [{ type: 'text', text: 'REDACTED BY POLICY' }])
    await appendToolAt(fixture, 2, 0, 'reused-call', 'dsh_pi_tui_svg', secondArgs, svgContentBlocks(secondFact))
    await waitFor('both reused-call SVG cards are projected', () =>
      wireNodes(fixture.pane.frames()).filter(node => node.k === 'tool').length >= 2, 30_000)
    expandToolCards(fixture)
    await waitFor('the valid reused-call row paints its own image', () =>
      // observation deadline: the painted image node is the completion signal
      imageCarriesBlob(fixture.pane.frames(), secondBlob), 30_000)
    const nodes = wireNodes(fixture.pane.frames())
    const images = nodes.filter(node => node.k === 'image')
    assert.equal(images.length, 1, 'only the authorized row may paint an image')
    assert.equal(images[0]?.p?.alt, 'Figure 2')
    assert.equal(images[0]?.p?.blob, secondBlob)
    const text = JSON.stringify(nodes.filter(node => node.k === 'code').map(node => node.p?.text))
    assert.match(text, /REDACTED BY POLICY/u)
    assert.equal(fixture.pane.blobIds().includes(firstBlob), false, 'the redacted row sends no blob')
    assert.equal(fixture.pane.blobIds().includes(secondBlob), true)
  } finally {
    // bounded teardown window: dispose the app, pane and Host before the next case
    await fixture.settle()
  }
})

test('two reused-callId SVG rows each paint their own digest blob', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['PRD', '-SVG-REUSE-TWO'],
    startup: { sessionId: SESSION_ID },
    persistedBlankSessions: [{ id: SESSION_ID }],
    nativeImages: true,
  })
  try {
    const firstArgs = { title: 'Figure 1', description: 'first figure', svg: FIGURE_ONE_SOURCE }
    const secondArgs = { title: 'Figure 2', description: 'second figure', svg: FIGURE_TWO_SOURCE }
    const firstFact = svgFactFromArgs(firstArgs)
    const secondFact = svgFactFromArgs(secondArgs)
    const firstBlob = digestOf(FIGURE_ONE_SOURCE)
    const secondBlob = digestOf(FIGURE_TWO_SOURCE)
    await appendToolAt(fixture, 1, 0, 'reused-call', 'dsh_pi_tui_svg', firstArgs, svgContentBlocks(firstFact))
    await appendToolAt(fixture, 2, 0, 'reused-call', 'dsh_pi_tui_svg', secondArgs, svgContentBlocks(secondFact))
    await waitFor('both reused-call SVG cards are projected', () =>
      wireNodes(fixture.pane.frames()).filter(node => node.k === 'tool').length >= 2, 30_000)
    expandToolCards(fixture)
    await waitFor('both reused-call rows paint their own image', () =>
      // observation deadline: both painted image nodes are the completion signal
      imageCarriesBlob(fixture.pane.frames(), firstBlob) && imageCarriesBlob(fixture.pane.frames(), secondBlob), 30_000)
    const images = wireNodes(fixture.pane.frames()).filter(node => node.k === 'image')
    assert.equal(images.length, 2)
    const byAlt = new Map(images.map(image => [image.p?.alt, image.p?.blob]))
    assert.equal(byAlt.get('Figure 1'), firstBlob, 'the first row keeps its own digest')
    assert.equal(byAlt.get('Figure 2'), secondBlob, 'the second row keeps its own digest')
  } finally {
    // bounded teardown window: dispose the app, pane and Host before the next case
    await fixture.settle()
  }
})



test('a conflicting PTC subCallId is rejected by the real fold before disclosure state can collide', () => {
  const firstArgs = { title: 'Figure 1', description: 'first', svg: FIGURE_ONE_SOURCE }
  const secondArgs = { title: 'Figure 2', description: 'second', svg: FIGURE_TWO_SOURCE }
  const firstFact = svgFactFromArgs(firstArgs)
  assert.ok(firstFact !== undefined)
  const folder = new TranscriptFolder()
  assert.throws(() => folder.apply([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: 1, data: { turn: 1, step: 0 } },
    { type: 'tool/call', seq: 3, time: 1, data: { turn: 1, step: 0, callId: ToolCallId('reused-parent'), name: 'run_code', arguments: JSON.stringify({ code: '', description: 'PTC parent' }) } },
    { type: 'tool/ptc-dispatch-start', seq: 4, time: 1, data: {
      rootCallId: 'reused-parent', parentCallId: 'reused-parent', subCallId: 'reused-parent:code:1',
      name: 'dsh_pi_tui_svg', arguments: firstArgs,
    } },
    { type: 'tool/ptc-dispatch', seq: 5, time: 1, data: {
      rootCallId: 'reused-parent', parentCallId: 'reused-parent', subCallId: 'reused-parent:code:1',
      name: 'dsh_pi_tui_svg', arguments: firstArgs, isError: false, content: svgContentBlocks(firstFact),
    } },
    { type: 'tool/result', seq: 6, time: 1, data: {
      turn: 1, step: 0,
      message: { id: MessageId('ptc-parent-1'), role: 'tool', toolCallId: ToolCallId('reused-parent'), content: [{ type: 'text', text: '(no output)' }], source: { kind: 'tool', callId: ToolCallId('reused-parent') } },
    } },
    { type: 'turn/end', seq: 7, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 8, time: 1, data: { turn: 2 } },
    { type: 'step/start', seq: 9, time: 1, data: { turn: 2, step: 0 } },
    { type: 'tool/call', seq: 10, time: 1, data: { turn: 2, step: 0, callId: ToolCallId('reused-parent'), name: 'run_code', arguments: JSON.stringify({ code: '', description: 'PTC parent' }) } },
    { type: 'tool/ptc-dispatch-start', seq: 11, time: 1, data: {
      rootCallId: 'reused-parent', parentCallId: 'reused-parent', subCallId: 'reused-parent:code:1',
      name: 'dsh_pi_tui_svg', arguments: secondArgs,
    } },
  ] as never), /conflicting PTC sub-call identity/u)
})
/** The node kinds and code texts the production TSP mapper emits for one row. */
function mappedResultOf(blocks: readonly unknown[], name: string, argsRaw: string): {
  readonly kinds: string[]
  readonly text: string
} {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: 1, data: { turn: 1, step: 0 } },
    { type: 'tool/call', seq: 3, time: 1, data: { turn: 1, step: 0, callId: ToolCallId('call-present'), name, arguments: argsRaw } },
    { type: 'tool/result', seq: 4, time: 1, data: {
      turn: 1, step: 0,
      message: {
        id: MessageId('result-present'),
        role: 'tool',
        toolCallId: ToolCallId('call-present'),
        content: blocks,
        source: { kind: 'tool', callId: ToolCallId('call-present') },
      },
    } },
    { type: 'turn/end', seq: 5, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as never)
  const rows = folder.messages()
  assert.equal(rows.length, 1)
  const view = transcriptView(projectTranscriptStructure(rows), new TranscriptNodeKeys(), { chartKindsSupported: true })
  const kinds: string[] = []
  const texts: string[] = []
  const walk = (node: { kind: string; props?: Record<string, unknown>; children: readonly unknown[] }): void => {
    kinds.push(node.kind)
    const text = node.props?.text
    if (typeof text === 'string') texts.push(text)
    for (const child of node.children) walk(child as { kind: string; props?: Record<string, unknown>; children: readonly unknown[] })
  }
  for (const child of (view as unknown as { children: readonly unknown[] }).children) {
    walk(child as { kind: string; props?: Record<string, unknown>; children: readonly unknown[] })
  }
  return { kinds, text: texts.join('\n') }
}

test('the TSP mapper paints the publication summary and never the receipt machine block', () => {
  const mapped = mappedResultOf([
    { type: 'text', text: 'Selected 2 visuals for presentation.' },
    { type: 'text', text: 'visual-published-v1:{"version":1,"published":[{"ref":"sv1_0123456789abcdef0123"},{"ref":"sv1_0123456789abcdef0124"}]}' },
  ], 'present_visual', JSON.stringify({ visuals: [{ ref: 'sv1_0123456789abcdef0123' }, { ref: 'sv1_0123456789abcdef0124' }] }))
  assert.ok(mapped.text.includes('Selected 2 visuals for presentation.'), `the summary is painted:\n${mapped.text}`)
  assert.ok(!mapped.text.includes('visual-published-v1:'), `the receipt is never painted:\n${mapped.text}`)
  assert.ok(!mapped.kinds.includes('chart'), 'the publication tool never emits a chart node')
  assert.ok(!mapped.kinds.includes('image'), 'the publication tool never emits an image node')
})

test('the TSP mapper keeps a failed publication’s readable reason', () => {
  const mapped = mappedResultOf(
    [{ type: 'text', text: 'unknown visual ref sv1_0123456789abcdef0123' }],
    'present_visual',
    JSON.stringify({ visuals: [{ ref: 'sv1_0123456789abcdef0123' }] }),
  )
  assert.ok(mapped.text.includes('unknown visual ref'), `the failure reason is painted:\n${mapped.text}`)
})
