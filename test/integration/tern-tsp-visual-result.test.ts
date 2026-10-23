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
import type { TspWireFrame } from '../support/tsp-terminal-fixture.ts'
import { chartContentBlocks, chartFactFromArgs } from '../../src/domain/visual/chart.ts'
import { svgContentBlocks, svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

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
