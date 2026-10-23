/**
 * PR-D: the resident Host visual tool definitions.
 *
 * The registry contract under test: both names are globally visible, their
 * output carries NO `presentationMeta` (the revised D0 contract), argument
 * validation fails closed, and a same-name definition is never shadowed.
 * @module @xmoon76/dsh-pi-tui/visual-tools.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  apply as applyVisualTools,
  CHART_TOOL_NAME,
  SVG_TOOL_NAME,
} from '../../src/app/host/visual-tools.ts'
import { svgDigest } from '../../src/domain/visual/svg.ts'

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/></svg>'

function mountRegistry(): Context {
  const ctx = new Context()
  ;(ctx as unknown as { provide(name: string, value: object): void }).provide('systemPrompt', {
    tools: () => {},
    section: () => () => {},
  })
  new ToolRuntime(ctx)
  return ctx
}

function chartArgs() {
  return {
    kind: 'bars',
    title: 'Request latency',
    unit: 'ms',
    series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
  }
}

function svgArgs() {
  return { title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }
}

async function execute(ctx: Context, name: string, args: unknown) {
  return await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`visual-${name}`),
    name,
    arguments: args,
  })
}

test('both visual tools are registered globally under their stable names', () => {
  const ctx = mountRegistry()
  applyVisualTools(ctx)
  assert.notEqual(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.notEqual(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), [CHART_TOOL_NAME, SVG_TOOL_NAME].sort())
})

test('the chart tool returns the canonical fact, exact text and NO presentation meta', async () => {
  const ctx = mountRegistry()
  applyVisualTools(ctx)
  const result = await execute(ctx, CHART_TOOL_NAME, chartArgs())
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(Object.hasOwn(result, 'meta'), false, 'revised D0: no presentationMeta on any path')
  const text = JSON.stringify(result.content)
  assert.match(text, /p50 {2}42 ms/u)
  assert.match(text, /2 supplied values/u)
  assert.match(text, /visual-v1:/u)
  assert.equal(result.isError === false && (result.value as { version?: number }).version, 1)
  assert.equal(result.isError === false && (result.value as { type?: string }).type, 'chart')
})

test('the SVG tool returns a credential whose digest matches the durable source, with NO meta', async () => {
  const ctx = mountRegistry()
  applyVisualTools(ctx)
  const result = await execute(ctx, SVG_TOOL_NAME, svgArgs())
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(Object.hasOwn(result, 'meta'), false)
  const text = JSON.stringify(result.content)
  assert.match(text, /Service topology/u)
  assert.match(text, /SVG source available/u)
  const line = (result.content as Array<{ type: string; text?: string }>).find(block => block.type === 'text' && block.text?.startsWith('visual-v1:'))
  assert.ok(line?.text !== undefined)
  const fact = JSON.parse(line.text.slice('visual-v1:'.length)) as { digest: string; bytes: number }
  assert.equal(fact.digest, svgDigest(SVG_SOURCE))
  assert.equal(fact.bytes, Buffer.byteLength(SVG_SOURCE))
})

test('invalid chart input fails closed with a readable reason and no meta', async () => {
  const ctx = mountRegistry()
  applyVisualTools(ctx)
  const result = await execute(ctx, CHART_TOOL_NAME, { ...chartArgs(), series: [{ label: 'only', value: 1 }] })
  assert.equal(result.isError, true)
  assert.equal(Object.hasOwn(result, 'meta'), false)
  assert.match(JSON.stringify(result.content), /between 2 and 12/u)
})

test('an unsafe SVG is refused by the admission gate and produces no result fact', async () => {
  const ctx = mountRegistry()
  applyVisualTools(ctx)
  const result = await execute(ctx, SVG_TOOL_NAME, {
    title: 'Bad',
    description: 'bad figure',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><script>alert(1)</script></svg>',
  })
  assert.equal(result.isError, true)
  assert.equal(Object.hasOwn(result, 'meta'), false)
  assert.match(JSON.stringify(result.content), /SVG rejected/u)
})

test('a visible same-name definition is never shadowed', () => {
  const ctx = mountRegistry()
  ctx.tools.register(defineTool({
    name: CHART_TOOL_NAME,
    description: 'business tool',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'business',
  }))
  assert.throws(() => applyVisualTools(ctx), /name conflict/u)
})
