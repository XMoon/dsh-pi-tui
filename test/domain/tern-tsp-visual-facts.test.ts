/**
 * PR-D: the pure TSP projection of the two visual tool results.
 *
 * The mapper is a pure function: the chart draws only when the pane
 * negotiated the `chart` kind, the SVG image node appears only for a prepared
 * `ready` state, and the machine line is never displayed. No session, loader
 * or SDK is involved.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-visual-facts.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TranscriptToolMessage } from '../../src/domain/transcript/types.ts'
import { textOf } from '../../src/domain/transcript/folder.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { chartContentBlocks, chartFactFromArgs } from '../../src/domain/visual/chart.ts'
import { svgContentBlocks, svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import {
  TranscriptNodeKeys,
  transcriptView,
  type ToolSvgState,
} from '../../src/tui/tsp/transcript-view.ts'

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/></svg>'

interface NodeLike {
  readonly kind: string
  readonly props: Record<string, unknown>
  readonly children: readonly NodeLike[]
}

function collect(view: { children: readonly unknown[] }): NodeLike[] {
  const out: NodeLike[] = []
  const walk = (node: NodeLike): void => {
    out.push(node)
    for (const child of node.children) walk(child)
  }
  for (const child of view.children) walk(child as NodeLike)
  return out
}

function toolRow(name: string, args: unknown, blocks: readonly ContentBlock[], overrides: Partial<TranscriptToolMessage> = {}): TranscriptToolMessage {
  return {
    kind: 'tool',
    turn: 1,
    name,
    args: JSON.stringify(args),
    result: textOf(blocks),
    status: 'ok',
    resultBlocks: blocks,
    callId: 'call-1',
    ...overrides,
  }
}

function render(message: TranscriptToolMessage, options: {
  chartKindsSupported?: boolean
  toolSvgStates?: ReadonlyMap<TranscriptToolMessage, ToolSvgState>
} = {}): NodeLike[] {
  const view = transcriptView(projectTranscriptStructure([message]), new TranscriptNodeKeys(), options)
  return collect(view as unknown as { children: readonly unknown[] })
}

function chartMessage(): TranscriptToolMessage {
  const args = {
    kind: 'bars' as const,
    title: 'Request latency',
    unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  }
  return toolRow('dsh_pi_tui_chart', args, chartContentBlocks(chartFactFromArgs(args)))
}

function svgMessage(): TranscriptToolMessage {
  const args = { title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }
  return toolRow('dsh_pi_tui_svg', args, svgContentBlocks(svgFactFromArgs(args)))
}

test('a negotiated chart kind emits one native chart plus the exact value rows', () => {
  const nodes = render(chartMessage(), { chartKindsSupported: true })
  const chart = nodes.find(node => node.kind === 'chart')
  assert.ok(chart !== undefined, `chart node missing: ${nodes.map(n => n.kind).join(',')}`)
  assert.equal(chart.props.kind, 'bars')
  assert.equal(chart.props.summary, 'Request latency (ms)')
  assert.deepEqual(chart.props.series, [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }])
  const text = JSON.stringify(nodes.filter(node => node.kind === 'code').map(node => node.props.text))
  assert.match(text, /p50 {2}42 ms/u)
  assert.match(text, /2 supplied values/u)
  assert.doesNotMatch(JSON.stringify(nodes), /visual-v1:/u, 'the machine line is never a displayed node')
})

test('without the chart kind the same row emits text only', () => {
  const nodes = render(chartMessage(), { chartKindsSupported: false })
  assert.equal(nodes.some(node => node.kind === 'chart'), false)
  const text = JSON.stringify(nodes.filter(node => node.kind === 'code').map(node => node.props.text))
  assert.match(text, /p50 {2}42 ms/u)
})

test('a replaced chart content renders the replacement and no chart node', () => {
  const nodes = render(toolRow('dsh_pi_tui_chart', {}, [{ type: 'text', text: 'REPLACED by policy' }]), { chartKindsSupported: true })
  assert.equal(nodes.some(node => node.kind === 'chart'), false)
  assert.match(JSON.stringify(nodes), /REPLACED by policy/u)
})

test('a ready SVG state emits the native image with the title alt and the description', () => {
  const message = svgMessage()
  const states = new Map<TranscriptToolMessage, ToolSvgState>([[message, {
    state: 'ready',
    blobId: 'a'.repeat(64),
    fact: svgFactFromArgs({ title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }),
    source: SVG_SOURCE,
  }]])
  const nodes = render(message, { toolSvgStates: states })
  const image = nodes.find(node => node.kind === 'image')
  assert.ok(image !== undefined, `image node missing: ${nodes.map(n => n.kind).join(',')}`)
  assert.equal(image.props.blob, 'a'.repeat(64))
  assert.equal(image.props.alt, 'Service topology')
  assert.match(JSON.stringify(nodes), /Gateway -> App -> Database/u)
  assert.doesNotMatch(JSON.stringify(nodes), /visual-v1:/u)
})

test('an unauthorized SVG row keeps the text and explains the absence', () => {
  const message = svgMessage()
  const states = new Map<TranscriptToolMessage, ToolSvgState>([[message, { state: 'invalid', reason: 'SVG result credential is missing' }]])
  const nodes = render(message, { toolSvgStates: states })
  assert.equal(nodes.some(node => node.kind === 'image'), false)
  assert.match(JSON.stringify(nodes), /Drawing unavailable/u)
  assert.match(JSON.stringify(nodes), /Gateway -> App -> Database/u)
})

test('a pane without native image/blob capability emits no image node', () => {
  const message = svgMessage()
  const states = new Map<TranscriptToolMessage, ToolSvgState>([[message, {
    state: 'unsupported',
    fact: svgFactFromArgs({ title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }),
    source: SVG_SOURCE,
  }]])
  const nodes = render(message, { toolSvgStates: states })
  assert.equal(nodes.some(node => node.kind === 'image'), false)
  assert.match(JSON.stringify(nodes), /Native SVG display unavailable/u)
})

test('the no-chart text path carries the FINAL fact title', () => {
  const nodes = render(chartMessage(), { chartKindsSupported: false })
  assert.match(JSON.stringify(nodes.filter(node => node.kind === 'code').map(node => node.props.text)), /Request latency \(ms\)/u)
})

test('a blocked/error chart result never emits a chart node', () => {
  const message = chartMessage()
  const nodes = render({ ...message, status: 'error' }, { chartKindsSupported: true })
  assert.equal(nodes.some(node => node.kind === 'chart'), false)
  assert.match(JSON.stringify(nodes), /Request latency/u)
})

test('a blocked/error SVG result never emits an image node even with a ready state', () => {
  const message = svgMessage()
  const blocked: TranscriptToolMessage = { ...message, status: 'error' }
  const states = new Map<TranscriptToolMessage, ToolSvgState>([[blocked, {
    state: 'ready', blobId: 'b'.repeat(64),
    fact: svgFactFromArgs({ title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }),
    source: SVG_SOURCE,
  }]])
  const nodes = render(blocked, { toolSvgStates: states })
  assert.equal(nodes.some(node => node.kind === 'image'), false)
  assert.match(JSON.stringify(nodes), /Gateway -> App -> Database/u)
})

test('a PTC SVG child exposes its admitted source node (not only a promise)', () => {
  const child = svgMessage()
  child.subCallId = 'call-1:ptc:2'
  const parent: TranscriptToolMessage = {
    kind: 'tool', turn: 1, name: 'run_code', args: '{}', result: 'parent', status: 'ok',
    callId: 'call-parent', resultBlocks: [{ type: 'text', text: 'parent' }], subCalls: [child],
  }
  const states = new Map<TranscriptToolMessage, ToolSvgState>([[child, {
    state: 'ready', blobId: 'c'.repeat(64),
    fact: svgFactFromArgs({ title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }),
    source: SVG_SOURCE,
  }]])
  const nodes = render(parent, { toolSvgStates: states })
  const codeText = JSON.stringify(nodes.filter(node => node.kind === 'code').map(node => node.props.text))
  assert.match(codeText, /<svg/u, `the child source node is present: ${codeText}`)
  assert.equal(nodes.some(node => node.kind === 'image'), true)
})

test('a PTC child carries its own chart node and never the parent result', () => {
  const child = chartMessage()
  child.subCallId = 'call-1:ptc:1'
  const parent: TranscriptToolMessage = {
    kind: 'tool',
    turn: 1,
    name: 'run_code',
    args: '{}',
    result: 'parent result',
    status: 'ok',
    callId: 'call-parent',
    resultBlocks: [{ type: 'text', text: 'parent result' }],
    subCalls: [child],
  }
  const nodes = render(parent, { chartKindsSupported: true })
  assert.equal(nodes.filter(node => node.kind === 'chart').length, 1, 'exactly one child chart node')
  assert.match(JSON.stringify(nodes), /p50 {2}42 ms/u)
})


test('a real durable PTC dispatch folds and projects the nested SVG source/image', () => {
  const args = { title: 'PTC topology', description: 'Nested gateway', svg: SVG_SOURCE }
  const fact = svgFactFromArgs(args)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 0, step: 0, callId: 'code-1', name: 'run_code', arguments: '{}' } },
    { type: 'tool/ptc-dispatch-start', seq: 2, time: 1, data: {
      rootCallId: 'code-1', parentCallId: 'code-1', subCallId: 'code-1:code:1',
      name: 'dsh_pi_tui_svg', arguments: args,
    } },
    { type: 'tool/ptc-dispatch', seq: 3, time: 1, data: {
      rootCallId: 'code-1', parentCallId: 'code-1', subCallId: 'code-1:code:1',
      name: 'dsh_pi_tui_svg', arguments: args, isError: false, content: svgContentBlocks(fact),
    } },
    { type: 'tool/result', seq: 4, time: 1, data: {
      turn: 0, step: 0,
      message: { id: 'msg-1', role: 'tool', toolCallId: 'code-1', content: [{ type: 'text', text: '(no output)' }], source: { kind: 'tool', callId: 'code-1' } },
    } },
  ] as never)
  const parent = folder.messages()[0] as TranscriptToolMessage
  assert.equal(parent.subCalls?.[0]?.name, 'dsh_pi_tui_svg')
  const child = parent.subCalls![0]!
  const states = new Map<TranscriptToolMessage, ToolSvgState>([[child, {
    state: 'ready', blobId: 'd'.repeat(64), fact, source: SVG_SOURCE,
  }]])
  const nodes = render(parent, { toolSvgStates: states })
  assert.equal(nodes.some(node => node.kind === 'image'), true)
  assert.match(JSON.stringify(nodes.filter(node => node.kind === 'code').map(node => node.props.text)), /<svg/u)
  assert.match(JSON.stringify(nodes), /Nested gateway/u)
})


test('a no-image PTC SVG child still exposes the admitted source text', () => {
  const args = { title: 'PTC topology', description: 'Nested gateway', svg: SVG_SOURCE }
  const fact = svgFactFromArgs(args)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 0, step: 0, callId: 'code-2', name: 'run_code', arguments: '{}' } },
    { type: 'tool/ptc-dispatch-start', seq: 2, time: 1, data: {
      rootCallId: 'code-2', parentCallId: 'code-2', subCallId: 'code-2:code:1',
      name: 'dsh_pi_tui_svg', arguments: args,
    } },
    { type: 'tool/ptc-dispatch', seq: 3, time: 1, data: {
      rootCallId: 'code-2', parentCallId: 'code-2', subCallId: 'code-2:code:1',
      name: 'dsh_pi_tui_svg', arguments: args, isError: false, content: svgContentBlocks(fact),
    } },
    { type: 'tool/result', seq: 4, time: 1, data: {
      turn: 0, step: 0,
      message: { id: 'msg-2', role: 'tool', toolCallId: 'code-2', content: [{ type: 'text', text: '(no output)' }], source: { kind: 'tool', callId: 'code-2' } },
    } },
  ] as never)
  const parent = folder.messages()[0] as TranscriptToolMessage
  const child = parent.subCalls![0]!
  const states = new Map<TranscriptToolMessage, ToolSvgState>([[child, { state: 'unsupported', fact, source: SVG_SOURCE }]])
  const nodes = render(parent, { toolSvgStates: states })
  assert.equal(nodes.some(node => node.kind === 'image'), false)
  assert.match(JSON.stringify(nodes.filter(node => node.kind === 'code').map(node => node.props.text)), /<svg/u)
  assert.match(JSON.stringify(nodes), /Native SVG display unavailable/u)
})
