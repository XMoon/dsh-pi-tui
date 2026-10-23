/**
 * PR-D: the Remote presentation path carries the two visual tool results.
 *
 * The Host session log is the authority; the retained Remote Client folds the
 * same durable `tool/call.arguments` and `tool/result` content, and the TSP
 * renderer projects the native chart / SVG blob. The model and terminal are
 * scripted boundaries; the Host/Remote composition, fold and SDK are real.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-remote-visual-result.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountRemotePresentationHost, mountRemoteRunner } from '../app/runner-remote-presentation.test.ts'
import { waitFor } from '../support/remote-application-fixture.ts'
import type { TspWireFrame } from '../support/tsp-terminal-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { chartContentBlocks, chartFactFromArgs } from '../../src/domain/visual/chart.ts'
import { svgContentBlocks, svgFactFromArgs } from '../../src/domain/visual/svg.ts'

const SESSION_ID = 'prd-remote-visual-session'
const PRESET_ID = 'prd-remote-visual-preset'

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
    for (const op of frame.ops) if (op[0] === 'add') walk(op[4] as unknown as WireNodeLike)
  }
  return out
}

function imageCarriesBlob(frames: readonly TspWireFrame[], blobId: string): boolean {
  const images = new Set<string>()
  for (const frame of frames) {
    for (const op of frame.ops) {
      if (op[0] === 'add') {
        const walk = (node: WireNodeLike): void => {
          if (node.k === 'image') {
            if (typeof node.id === 'string') images.add(node.id)
            if ((node.p as { blob?: string } | undefined)?.blob === blobId) images.add(`blob:${blobId}`)
          }
          for (const child of node.c ?? []) walk(child)
        }
        walk(op[4] as unknown as WireNodeLike)
      }
      if (op[0] === 'set' && typeof op[1] === 'string' && (op[2] as { blob?: string }).blob === blobId) return true
    }
  }
  return images.has(`blob:${blobId}`)
}

/**
 * PR-D RFL-016: expand the projected tool cards through the Tern `toggle`
 * event; a ready SVG card stays collapsed (and blob-free) until this demand.
 */
function expandToolCards(fixture: { readonly pane: { event(value: unknown): void; frames(): readonly TspWireFrame[] } }): void {
  const frames = fixture.pane.frames()
  const sf = frames[frames.length - 1]?.sf
  if (sf === undefined) throw new Error('the Remote pane has no surface frame to address the toggle event')
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

interface HostSession { append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void }

async function sessionOf(host: { readonly ctx: { sessions: { get(id: unknown): unknown } } }): Promise<HostSession> {
  let session: HostSession | undefined
  await waitFor('the Host session exists', () => {
    session = host.ctx.sessions.get(SessionId(SESSION_ID)) as HostSession | undefined
    return session !== undefined
  }, 30_000)
  return session!
}

function appendTool(session: HostSession, callId: string, name: string, args: unknown, blocks: readonly unknown[]): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  session.append('tool/call', { turn: 1, step: 0, callId: ToolCallId(callId), name, arguments: JSON.stringify(args) })
  session.append('tool/result', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId(`result-${callId}`),
      role: 'tool',
      toolCallId: ToolCallId(callId),
      content: blocks,
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, { surfaceOp: 'append' })
}

test('a Remote chart result crosses the wire and paints the same ordered values', async (t) => {
  const life = testLifecycle(t)
  const host = await mountRemotePresentationHost(life, PRESET_ID)
  await host.harness.create(SessionId(SESSION_ID), { provider: 'smoke', model: 'smoke' } as never, { cwd: host.anchorDir })
  const fixture = await mountRemoteRunner(life, {
    presetId: PRESET_ID, resumeSessionId: SESSION_ID, host, renderer: 'tsp', nativeChart: true,
  })
  {
    const pane = fixture.pane
    assert.ok(pane, 'the Remote runner uses the scripted TSP pane')
    const args = {
      kind: 'bars' as const,
      title: 'Request latency',
      unit: 'ms',
      series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
    }
    appendTool(await sessionOf(host), 'remote-chart-1', 'dsh_pi_tui_chart', args, chartContentBlocks(chartFactFromArgs(args)))
    await waitFor('the Remote pane carries the native chart node', () =>
      wireNodes(pane.frames()).some(node => node.k === 'chart'), 30_000)
    const nodes = wireNodes(pane.frames())
    const chart = nodes.find(node => node.k === 'chart')
    assert.equal(chart?.p?.kind, 'bars')
    assert.deepEqual(chart?.p?.series, [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }])
    assert.match(JSON.stringify(nodes.filter(node => node.k === 'code').map(node => node.p?.text)), /42 ms/u)
    assert.doesNotMatch(JSON.stringify(nodes), /visual-v1:/u)
  }
})

test('a Remote SVG result authorizes the same source digest and paints one blob', async (t) => {
  const life = testLifecycle(t)
  const host = await mountRemotePresentationHost(life, PRESET_ID)
  await host.harness.create(SessionId(SESSION_ID), { provider: 'smoke', model: 'smoke' } as never, { cwd: host.anchorDir })
  const fixture = await mountRemoteRunner(life, {
    presetId: PRESET_ID, resumeSessionId: SESSION_ID, host, renderer: 'tsp', nativeImages: true,
  })
  {
    const pane = fixture.pane
    assert.ok(pane, 'the Remote runner uses the scripted TSP pane')
    const args = { title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }
    const expectedBlobId = createHash('sha256').update(Buffer.from(SVG_SOURCE, 'utf8')).digest('hex')
    appendTool(await sessionOf(host), 'remote-svg-1', 'dsh_pi_tui_svg', args, svgContentBlocks(svgFactFromArgs(args)))
    await waitFor('the Remote SVG tool card is projected', () =>
      wireNodes(pane.frames()).some(node => node.k === 'tool'), 30_000)
    assert.deepEqual(pane.blobIds(), [], 'a collapsed Remote SVG card sends no blob')
    expandToolCards({ pane })
    await waitFor('the Remote pane received the admitted SVG blob', () => pane.blobIds().includes(expectedBlobId), 30_000)
    await waitFor('the Remote pane painted the image node', () => imageCarriesBlob(pane.frames(), expectedBlobId), 30_000)
    const nodes = wireNodes(pane.frames())
    assert.match(JSON.stringify(nodes.filter(node => node.k === 'code').map(node => node.p?.text)), /Gateway -> App -> Database/u)
    assert.doesNotMatch(JSON.stringify(nodes), /visual-v1:/u)
  }
})
