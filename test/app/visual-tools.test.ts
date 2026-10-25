/**
 * The Host visual tool definitions and their profile-wide switch.
 *
 * The registry contract under test: all three names — the two generators and
 * `present_visual` — are globally visible while the `enabled` reference is On,
 * the output carries NO `presentationMeta` (the revised D0 contract), argument
 * validation fails closed, a same-name definition is never shadowed, and the
 * volatile switch owns ONE atomic group lifecycle (no half-enabled registry, no
 * duplicate, no leaked handle).
 * @module @xmoon76/dsh-pi-tui/visual-tools.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import ToolRuntime, { defineTool, renderToolsSdk, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  apply as applyVisualTools,
  CHART_TOOL_NAME,
  Config,
  PRESENT_VISUAL_TOOL_NAME,
  SVG_TOOL_NAME,
} from '../../src/app/host/visual-tools.ts'
import {
  VISUAL_TOOLS_STATUS_SERVICE,
  type VisualToolsRuntimeStatus,
} from '../../src/domain/visual/runtime-status.ts'
import { svgDigest } from '../../src/domain/visual/svg.ts'
import { chartContentBlocks, chartFactFromArgs, type ChartArgs } from '../../src/domain/visual/chart.ts'
import { visualReference } from '../../src/domain/visual/reference.ts'

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/></svg>'

/** The turn-boundary stand-in: this suite never runs a model turn, so the
 *  projected reference is never injected and `stateOf` answers "no boundary". */
const NO_BOUNDARY = { stateOf: () => undefined }

function mountRegistry(): Context {
  const ctx = new Context()
  ;(ctx as unknown as { provide(name: string, value: object): void }).provide('systemPrompt', {
    tools: () => {},
    section: () => () => {},
  })
  ;(ctx as unknown as { provide(name: string, value: object): void }).provide('agents', { get: () => undefined })
  ;(ctx as unknown as { provide(name: string, value: object): void }).provide('sessionQuery', {
    observeSession: async () => { throw new Error('this suite never observes a Session') },
  })
  ;(ctx as unknown as { provide(name: string, value: object): void }).provide('sessionProjections', NO_BOUNDARY)
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

function chartArgs(): ChartArgs {
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

test('all three visual tools are registered globally under their stable names', () => {
  const { ctx, applied } = mountVisualTools()
  assert.equal(applied(), true)
  assert.notEqual(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.notEqual(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.deepEqual(
    ctx.tools.schemas().map(schema => schema.name).sort(),
    [CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME].sort(),
  )
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

test('an Off mount registers no visual tool and reports the honest runtime state', () => {
  const { ctx, applied } = mountVisualTools(false)
  assert.equal(applied(), false)
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), [])
})

test('the volatile switch releases all three registrations and restores them exactly once', () => {
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
  assert.equal(ctx.tools.schemas().filter(schema => schema.name === PRESENT_VISUAL_TOOL_NAME).length, 1)

  // On -> On never registers the group twice.
  setEnabled(true)
  assert.deepEqual(
    ctx.tools.schemas().map(schema => schema.name).sort(),
    [CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME].sort(),
  )
})

test('an unrelated volatile path never toggles the registrations', () => {
  const { ctx, applied, setEnabled } = mountVisualTools()
  setEnabled(false)
  ctx.emit('loader/volatile-update', [['theme']])
  assert.equal(applied(), false, 'a non-enabled path leaves the current registration state alone')
})

test('a re-enable conflict leaves NO half-enabled group and reports it as not applied', () => {
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
  assert.deepEqual(
    ctx.tools.schemas().map(schema => schema.name).sort(),
    [CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME].sort(),
  )
})

test('a throwing tools/change listener never strands the other registrations on Off', () => {
  const { ctx, applied, setEnabled } = mountVisualTools()
  // A Host listener that throws on every removal notification: the first
  // disposer's synchronous `tools/change` emit propagates the failure.
  const off = ctx.on('tools/change', () => { throw new Error('tools/change listener exploded') })
  assert.throws(() => setEnabled(false), (error: unknown) => {
    assert.ok(error instanceof AggregateError, `every release failure is surfaced together: ${String(error)}`)
    assert.equal(error.errors.length, 3, 'ALL THREE disposers ran despite the first one throwing')
    assert.match(String(error.errors[0]), /tools\/change listener exploded/u)
    return true
  })
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined, 'the SVG disposer was not skipped')
  assert.equal(ctx.tools.get(PRESENT_VISUAL_TOOL_NAME), undefined, 'the present_visual disposer was not skipped')
  assert.equal(applied(), false, 'the group status reflects the real registry')
  // Once the broken Host listener is gone, the switch is applicable again.
  off()
  setEnabled(true)
  assert.equal(applied(), true)
  assert.deepEqual(
    ctx.tools.schemas().map(schema => schema.name).sort(),
    [CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME].sort(),
  )
})

test('a tools/change listener that re-enables mid-release settles on the newest target', () => {
  const ctx = mountRegistry()
  let enabled = true
  applyVisualTools(ctx, { enabled: { get: () => enabled } } as never)
  let reentered = false
  // A Host listener re-enters the switch SYNCHRONOUSLY from the chart disposer:
  // it commits On and emits the Loader event while Off is still releasing.
  const off = ctx.on('tools/change', () => {
    if (reentered || ctx.tools.get(CHART_TOOL_NAME) !== undefined) return
    reentered = true
    enabled = true
    ctx.emit('loader/volatile-update', [['enabled']])
  })

  enabled = false
  ctx.emit('loader/volatile-update', [['enabled']])
  off()
  assert.equal(reentered, true, 'the reentrant listener really fired during the release')
  const status = ctx.get(VISUAL_TOOLS_STATUS_SERVICE) as VisualToolsRuntimeStatus
  assert.equal(status.applied(), true, 'the newest target (On) owns a complete group')
  assert.deepEqual(
    ctx.tools.schemas().map(schema => schema.name).sort(),
    [CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME].sort(),
    'the outer release never clobbered or disposed the re-registered group',
  )

  // The serialized final state is reachable again: a later Off releases ALL.
  enabled = false
  ctx.emit('loader/volatile-update', [['enabled']])
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(PRESENT_VISUAL_TOOL_NAME), undefined)
  assert.equal(status.applied(), false)
})

test('a newer target queued during a THROWING release is still applied', () => {
  const ctx = mountRegistry()
  let enabled = true
  applyVisualTools(ctx, { enabled: { get: () => enabled } } as never)
  let reentered = false
  const off = ctx.on('tools/change', () => {
    // Removal notifications throw; registration notifications do not. The
    // first removal also commits On and emits the Loader event synchronously.
    if (ctx.tools.get(CHART_TOOL_NAME) !== undefined) return
    if (!reentered) {
      reentered = true
      enabled = true
      ctx.emit('loader/volatile-update', [['enabled']])
    }
    throw new Error('tools/change removal exploded')
  })

  enabled = false
  // Only the CHART removal finds the chart already gone from the registry, so
  // exactly one release failure is collected and surfaced as itself.
  assert.throws(() => ctx.emit('loader/volatile-update', [['enabled']]), /tools\/change removal exploded/u)
  off()
  assert.equal(reentered, true, 'the reentrant listener fired during the failing release')
  const status = ctx.get(VISUAL_TOOLS_STATUS_SERVICE) as VisualToolsRuntimeStatus
  assert.equal(status.applied(), true, 'the newest target survives the throwing transition')
  assert.deepEqual(
    ctx.tools.schemas().map(schema => schema.name).sort(),
    [CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME].sort(),
  )
})

test('disposing the owning fiber releases all registrations and the status service', async () => {
  const ctx = mountRegistry()
  const fiber = await ctx.plugin({
    name: 'visual-tools-fiber-probe',
    inject: ['tools'],
    Config,
    apply: applyVisualTools,
  })
  assert.notEqual(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.notEqual(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.notEqual(ctx.get(VISUAL_TOOLS_STATUS_SERVICE), undefined)

  await fiber.dispose()
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.equal(ctx.get(VISUAL_TOOLS_STATUS_SERVICE), undefined,
    'the fiber-owned status service is released with the registrations')
})

test('the model catalog and the PTC SDK carry all three visual names in one group', () => {
  const { ctx, setEnabled } = mountVisualTools()
  const names = () => ctx.tools.schemas().map(schema => schema.name).sort()
  assert.deepEqual(names(), [CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME].sort())
  const definitions = ctx.tools.schemas().map((schema) => {
    const definition = ctx.tools.get(schema.name)
    assert.ok(definition !== undefined)
    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: definition.output.schema,
    }
  })
  const sdkOn = renderToolsSdk(definitions)
  for (const name of [CHART_TOOL_NAME, SVG_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME]) {
    assert.match(sdkOn, new RegExp(name, 'u'), `${name} is visible to PTC while On`)
  }

  setEnabled(false)
  assert.deepEqual(names(), [])
  const sdkOff = renderToolsSdk([])
  for (const name of [CHART_TOOL_NAME, SVG_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME]) {
    assert.doesNotMatch(sdkOff, new RegExp(name, 'u'), `${name} disappears from the PTC SDK while Off`)
  }
})

test('a foreign present_visual owner blocks the WHOLE enable, leaving no partial group', () => {
  const { ctx, applied, setEnabled } = mountVisualTools(false)
  const foreign = defineTool({
    name: PRESENT_VISUAL_TOOL_NAME,
    description: 'foreign publication tool',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'foreign',
  })
  const releaseForeign = ctx.tools.register(foreign)

  assert.throws(() => setEnabled(true), /name conflict/u)
  assert.equal(applied(), false)
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined, 'the chart registration was rolled back')
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined, 'the SVG registration was rolled back')
  assert.equal(ctx.tools.get(PRESENT_VISUAL_TOOL_NAME), foreign, 'the foreign definition is never shadowed')

  releaseForeign()
  setEnabled(true)
  assert.equal(applied(), true)
})

test('a failure while registering the third tool rolls back the first two', () => {
  const { ctx, applied, setEnabled } = mountVisualTools(false)
  // Fail the THIRD registration only: the registry throws for present_visual.
  const originalRegister = ctx.tools.register.bind(ctx.tools)
  let presentAttempts = 0
  ;(ctx.tools as unknown as { register: (definition: ToolDefinition) => () => void }).register = (definition: ToolDefinition) => {
    if (definition.name === PRESENT_VISUAL_TOOL_NAME) {
      presentAttempts += 1
      throw new Error('registry refused present_visual')
    }
    return originalRegister(definition)
  }
  assert.throws(() => setEnabled(true), /registry refused present_visual/u)
  assert.equal(presentAttempts, 1)
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined, 'the chart registration was rolled back')
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined, 'the SVG registration was rolled back')
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), [], 'no half-enabled group survives')
  assert.equal(applied(), false, 'the status reports the real registry, never the committed target')
})

test('a throwing disposer still attempts every release in reverse order', () => {
  const { ctx, applied, setEnabled } = mountVisualTools()
  let attempted: string[] = []
  const originalRegister = ctx.tools.register.bind(ctx.tools)
  ;(ctx.tools as unknown as { register: (definition: ToolDefinition) => () => void }).register = (definition: ToolDefinition) => {
    const dispose = originalRegister(definition)
    // The realistic shape: the registry entry is removed FIRST, then the
    // synchronous `tools/change` emit propagates a listener failure.
    return () => {
      attempted.push(definition.name)
      dispose()
      if (definition.name === SVG_TOOL_NAME) throw new Error('svg disposer exploded')
    }
  }
  // Re-register the group under the wrapped registry.
  setEnabled(false)
  attempted = []
  setEnabled(true)
  assert.equal(applied(), true)
  assert.throws(() => setEnabled(false), /svg disposer exploded/u)
  assert.deepEqual(attempted, [PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME, CHART_TOOL_NAME],
    'releases run in reverse registration order and never stop at the first failure')
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined, 'the chart release still ran after the SVG failure')
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(PRESENT_VISUAL_TOOL_NAME), undefined)
  assert.equal(applied(), false)
  // The group is retryable: the switch applies again once nothing throws.
  setEnabled(true)
  assert.equal(applied(), true)
})

/** A registry whose `sessionProjections` reports one open step boundary. */
function mountWithBoundary(): { ctx: Context; boundary: { openTurnStartSeq: number | null; lastStepStartSeq: number | null; lastStepBoundary: { kind: 'start' | 'end'; seq: number } | null; lastTurn: number } } {
  const ctx = new Context()
  ;(ctx as unknown as { provide(name: string, value: object): void }).provide('systemPrompt', {
    tools: () => {},
    section: () => () => {},
  })
  ;(ctx as unknown as { provide(name: string, value: object): void }).provide('agents', { get: () => undefined })
  ;(ctx as unknown as { provide(name: string, value: object): void }).provide('sessionQuery', {
    observeSession: async () => { throw new Error('this suite never observes a Session') },
  })
  const boundary = {
    openTurnStartSeq: 3,
    lastStepStartSeq: 7,
    lastStepBoundary: { kind: 'start' as const, seq: 7 },
    lastTurn: 1,
  }
  ;(ctx as unknown as { provide(name: string, value: object): void }).provide('sessionProjections', {
    stateOf: () => boundary,
  })
  new ToolRuntime(ctx)
  return { ctx, boundary }
}

/** The contract-visible projection callback of one registered generator. */
function projectContentOf(ctx: Context, name: string) {
  const definition = ctx.tools.get(name)
  assert.ok(definition?.projectContent !== undefined, `${name} declares projectContent`)
  return definition.projectContent.bind(definition)
}

test('a generating result inside an open model step projects its stable reference before the fact', async () => {
  const { ctx } = mountWithBoundary()
  applyVisualTools(ctx, { enabled: { get: () => true } } as never)
  const projected = projectContentOf(ctx, CHART_TOOL_NAME)
  const blocks = chartContentBlocks(chartFactFromArgs(chartArgs()))
  const session = { id: 'session-probe' }
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('call-ref'),
    name: CHART_TOOL_NAME,
    arguments: chartArgs(),
  })
  assert.equal(result.isError, false)
  const content = projected(
    { agent: { session }, callId: ToolCallId('call-ref') } as never,
    { isError: false, content: blocks } as never,
  )
  assert.ok(content !== undefined, 'a real agent root call inside an open step gets a reference')
  const texts = content.map(block => block.type === 'text' ? block.text : '')
  assert.equal(texts.length, 3)
  assert.match(texts[1] as string, /^visual-ref-v1:sv1_[0-9a-f]{20}$/u)
  assert.match(texts[2] as string, /^visual-v1:/u, 'the fact stays the LAST block')
  // The ref is the documented tuple projection, not an arbitrary id.
  assert.equal(
    texts[1],
    `visual-ref-v1:${visualReference({ sessionId: 'session-probe', turn: 1, stepStartSeq: 7, callId: 'call-ref' })}`,
  )
})

test('an agentless, nested or failed generating call projects no reference', async () => {
  const { ctx } = mountWithBoundary()
  applyVisualTools(ctx, { enabled: { get: () => true } } as never)
  const projected = projectContentOf(ctx, CHART_TOOL_NAME)
  const blocks = chartContentBlocks(chartFactFromArgs(chartArgs()))
  // Agentless: the direct registry call used by other suites.
  assert.equal(projected({ callId: ToolCallId('c1') } as never, { isError: false, content: blocks } as never), undefined)
  // Nested PTC dispatch.
  assert.equal(
    projected({ agent: { session: { id: 's' } }, callId: ToolCallId('c2'), parent: Symbol('parent') } as never,
      { isError: false, content: blocks } as never),
    undefined,
  )
  // A failed result never gains a reference.
  assert.equal(
    projected({ agent: { session: { id: 's' } }, callId: ToolCallId('c3') } as never,
      { isError: true, content: blocks } as never),
    undefined,
  )
})

test('a result without a trailing visual fact keeps its exact projection', () => {
  const { ctx } = mountWithBoundary()
  applyVisualTools(ctx, { enabled: { get: () => true } } as never)
  const projected = projectContentOf(ctx, CHART_TOOL_NAME)
  const plain = [{ type: 'text' as const, text: 'not a visual result' }]
  assert.equal(
    projected({ agent: { session: { id: 's' } }, callId: ToolCallId('c4') } as never,
      { isError: false, content: plain } as never),
    undefined,
  )
})

test('present_visual refuses agentless, nested, empty, oversized, duplicated and malformed arguments', async () => {
  const { ctx } = mountWithBoundary()
  applyVisualTools(ctx, { enabled: { get: () => true } } as never)
  const ref = 'sv1_0123456789abcdef0123'
  const run = async (visuals: unknown) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('call-present'),
    name: PRESENT_VISUAL_TOOL_NAME,
    arguments: visuals,
  })
  // Empty.
  assert.equal((await run({ visuals: [] })).isError, true)
  // More than the hard cap.
  const tooMany = Array.from({ length: 9 }, (_, index) => ({ ref: `sv1_${String(index).padStart(20, '0')}` }))
  assert.equal((await run({ visuals: tooMany })).isError, true)
  // Agentless: the schema passes, the body refuses BEFORE any identity work.
  const agentless = await run({ visuals: [{ ref }] })
  assert.equal(agentless.isError, true)
  assert.match(JSON.stringify(agentless.content), /requires an agent Session/u)
  // Duplicated refs are rejected by the schema-level body check.
  const duplicated = await run({ visuals: [{ ref }, { ref }] })
  assert.equal(duplicated.isError, true)
  // A malformed ref never satisfies the parameter contract.
  const malformed = await run({ visuals: [{ ref: 'not-a-ref' }] })
  assert.equal(malformed.isError, true)
})

test('present_visual declares its concurrency safety and its exact output shape', () => {
  const { ctx } = mountWithBoundary()
  applyVisualTools(ctx, { enabled: { get: () => true } } as never)
  const definition = ctx.tools.get(PRESENT_VISUAL_TOOL_NAME)
  assert.ok(definition !== undefined)
  // A well-formed argument set classifies as concurrency safe: the tool never
  // waits for a same-step source, it refuses it.
  assert.equal(
    definition.isConcurrencySafe?.({ visuals: [{ ref: 'sv1_0123456789abcdef0123' }] }),
    true,
    'a same-step source is refused, never waited for',
  )
  assert.equal(Object.hasOwn(definition, 'meta'), false)
  const schema = JSON.stringify(definition.output.schema)
  assert.match(schema, /"published"/u)
  assert.match(schema, /"version"/u)
  assert.doesNotMatch(schema, /callId|turn|title|path|bytes/u, 'no redundant authority crosses the output contract')
})
