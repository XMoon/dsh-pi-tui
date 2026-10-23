/**
 * PR-D: the Host visual tool definitions and their profile-wide switch.
 *
 * The registry contract under test: both names are globally visible while the
 * `enabled` reference is On, the output carries NO `presentationMeta` (the
 * revised D0 contract), argument validation fails closed, a same-name
 * definition is never shadowed, and the volatile switch owns the registration
 * lifecycle (one atomic pair, no half-enabled registry, no duplicate).
 * @module @xmoon76/dsh-pi-tui/visual-tools.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  apply as applyVisualTools,
  CHART_TOOL_NAME,
  SVG_TOOL_NAME,
} from '../../src/app/host/visual-tools.ts'
import {
  VISUAL_TOOLS_STATUS_SERVICE,
  type VisualToolsRuntimeStatus,
} from '../../src/domain/visual/tool-identity.ts'
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

/** The visual-tools row over a controllable `.volatile()` value: the test
 *  changes the value and dispatches the Loader's commit event exactly like the
 *  real Loader does (commit FIRST, then notify this fiber). */
function mountVisualTools(enabled = true): {
  readonly ctx: Context
  readonly applied: () => boolean
  setEnabled(next: boolean): void
} {
  const ctx = mountRegistry()
  let value = enabled
  applyVisualTools(ctx, { enabled: { get: () => value } } as never)
  return {
    ctx,
    applied: () => (ctx.get(VISUAL_TOOLS_STATUS_SERVICE) as VisualToolsRuntimeStatus).applied(),
    setEnabled(next: boolean): void {
      value = next
      ctx.emit('loader/volatile-update', [['enabled']])
    },
  }
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
  const { ctx, applied } = mountVisualTools()
  assert.equal(applied(), true)
  assert.notEqual(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.notEqual(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), [CHART_TOOL_NAME, SVG_TOOL_NAME].sort())
})

test('the chart tool returns the canonical fact, exact text and NO presentation meta', async () => {
  const { ctx } = mountVisualTools()
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
  const { ctx } = mountVisualTools()
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
  const { ctx } = mountVisualTools()
  const result = await execute(ctx, CHART_TOOL_NAME, { ...chartArgs(), series: [{ label: 'only', value: 1 }] })
  assert.equal(result.isError, true)
  assert.equal(Object.hasOwn(result, 'meta'), false)
  assert.match(JSON.stringify(result.content), /between 2 and 12/u)
})

test('an unsafe SVG is refused by the admission gate and produces no result fact', async () => {
  const { ctx } = mountVisualTools()
  const result = await execute(ctx, SVG_TOOL_NAME, {
    title: 'Bad',
    description: 'bad figure',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><script>alert(1)</script></svg>',
  })
  assert.equal(result.isError, true)
  assert.equal(Object.hasOwn(result, 'meta'), false)
  assert.match(JSON.stringify(result.content), /SVG rejected/u)
})

test('a visible same-name definition is never shadowed at mount', () => {
  const ctx = mountRegistry()
  ctx.tools.register(defineTool({
    name: CHART_TOOL_NAME,
    description: 'business tool',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'business',
  }))
  assert.throws(
    () => applyVisualTools(ctx, { enabled: { get: () => true } } as never),
    /name conflict/u,
  )
})

test('an Off mount registers neither tool and reports the honest runtime state', () => {
  const { ctx, applied } = mountVisualTools(false)
  assert.equal(applied(), false)
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), [])
})

test('the volatile switch releases both registrations and restores them exactly once', () => {
  const { ctx, applied, setEnabled } = mountVisualTools()
  const chart = ctx.tools.get(CHART_TOOL_NAME)
  assert.notEqual(chart, undefined)

  setEnabled(false)
  assert.equal(applied(), false)
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), [])

  // A second Off is a no-op (it never touches a released handle).
  setEnabled(false)
  assert.equal(applied(), false)

  setEnabled(true)
  assert.equal(applied(), true)
  assert.equal(ctx.tools.schemas().filter(schema => schema.name === CHART_TOOL_NAME).length, 1)
  assert.equal(ctx.tools.schemas().filter(schema => schema.name === SVG_TOOL_NAME).length, 1)

  // On -> On never registers the pair twice.
  setEnabled(true)
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), [CHART_TOOL_NAME, SVG_TOOL_NAME].sort())
})

test('an unrelated volatile path never toggles the registrations', () => {
  const { ctx, applied, setEnabled } = mountVisualTools()
  setEnabled(false)
  ctx.emit('loader/volatile-update', [['theme']])
  assert.equal(applied(), false, 'a non-enabled path leaves the current registration state alone')
})

test('a re-enable conflict leaves NO half-enabled pair and reports it as not applied', () => {
  const { ctx, applied, setEnabled } = mountVisualTools(false)
  const foreign = defineTool({
    name: CHART_TOOL_NAME,
    description: 'foreign tool',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'foreign',
  })
  const releaseForeign = ctx.tools.register(foreign)

  // The chart name is occupied: the enable must fail atomically instead of
  // registering the SVG tool alone.
  assert.throws(() => setEnabled(true), /name conflict/u)
  assert.equal(applied(), false)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(CHART_TOOL_NAME)?.description, 'foreign tool')

  // The external definition leaves: the same switch can be applied again.
  releaseForeign()
  setEnabled(true)
  assert.equal(applied(), true)
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), [CHART_TOOL_NAME, SVG_TOOL_NAME].sort())
})

test('a throwing tools/change listener never strands the second registration on Off', () => {
  const { ctx, applied, setEnabled } = mountVisualTools()
  // A Host listener that throws on every removal notification: the first
  // disposer's synchronous `tools/change` emit propagates the failure.
  const off = ctx.on('tools/change', () => { throw new Error('tools/change listener exploded') })
  assert.throws(() => setEnabled(false), (error: unknown) => {
    assert.ok(error instanceof AggregateError, `both release failures are surfaced together: ${String(error)}`)
    assert.equal(error.errors.length, 2, 'BOTH disposers ran despite the first one throwing')
    assert.match(String(error.errors[0]), /tools\/change listener exploded/u)
    return true
  })
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined, 'the second disposer was not skipped')
  assert.equal(applied(), false, 'the pair status reflects the real registry')
  // Once the broken Host listener is gone, the switch is applicable again.
  off()
  setEnabled(true)
  assert.equal(applied(), true)
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), [CHART_TOOL_NAME, SVG_TOOL_NAME].sort())
})
