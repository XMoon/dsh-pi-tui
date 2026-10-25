/**
 * The visual publication path over the REAL DSH AgentLoop, SessionQuery,
 * SessionProjections and ToolRuntime.
 *
 * ```text
 * scripted LLM requests
 *   -> real AgentLoop durable turn/start, step/start, tool/call, tool/result
 *   -> production src/app/host/visual-tools.ts definitions
 *   -> the tool's projectContent reference injection
 *   -> the real tools/post-execute waterfall
 *   -> a durable tool/result read back through sessionQuery's live observation
 *   -> an INDEPENDENT cold replay through collectPublishedVisuals
 * ```
 *
 * The scripted model reads the REAL assembled request text: the positive case
 * proves the model actually received `visual-ref-v1:sv1_…` and then used that
 * exact value in a later step of the same turn — no test-side ref computation
 * stands in for the production projection.
 *
 * FIXTURE MANIFEST
 * - REAL: `mountAgentLoopTestDependencies` + `mountAgentLoopTestHarness`, the
 *   official SQLite `sessionQuery` engine (in-memory, search disabled), the
 *   official `sessionProjections` registry with the loop's own `turnBoundary`
 *   unit, the real ToolRuntime pipeline and the production Host row.
 * - STAND-INS: a scripted `LlmAdapter` (the model) and disposable test roots.
 * - ABSENT: a physical terminal, a Tern pane and a real user DSH_HOME.
 * @module @xmoon76/dsh-pi-tui/test/integration/visual-publication
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import {
  apply as applyVisualTools,
  CHART_TOOL_NAME,
  PRESENT_VISUAL_TOOL_NAME,
  SVG_TOOL_NAME,
} from '../../src/app/host/visual-tools.ts'
import {
  collectPublishedVisuals,
  collectVisualSources,
  type VisualSessionEvent,
} from '../../src/domain/visual/publication.ts'
import { svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/><text x="4" y="20" font-size="12">Gateway</text></svg>'

const CHART_ARGS = {
  kind: 'bars',
  title: 'Request latency',
  unit: 'ms',
  series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
}
const SVG_ARGS = { title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }

/** One scripted tool call the fake model issues. */
interface ScriptedCall {
  readonly callId: string
  readonly name: string
  readonly args: unknown
}

/** What one REAL model request carried (the model-visible evidence). */
interface ModelRequest {
  readonly toolNames: readonly string[]
  readonly promptText: string
}

/** One durable `tool/result` as the log records it. */
interface DurableResult {
  readonly callId: string
  readonly isError: boolean
  readonly texts: readonly string[]
}

/** A plan for one model request: return the tool calls that step issues. */
type StepPlan = (request: ModelRequest) => readonly ScriptedCall[]

/**
 * The scripted model. Each `stream()` call is one REAL model request; a plan
 * reads what the request actually carried, so a later step can consume what an
 * earlier step produced.
 */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: ModelRequest[] = []
  /** The plans installed for the NEXT requests (one entry per request). */
  steps: StepPlan[] = []

  override providerInfo(provider: string): { id: string; name: string } { return { id: provider, name: provider } }
  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider, id: 'm', name: 'M' }])
  }
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const toolNames = ((options as unknown as { tools?: readonly { name: string }[] }).tools ?? []).map(tool => tool.name)
    const promptText = JSON.stringify(options.messages ?? [])
    const request: ModelRequest = { toolNames, promptText }
    this.requests.push(request)
    const plan = this.steps[this.requests.length - 1]
    const batch = plan === undefined ? [] : plan(request)
    if (batch.length === 0) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    for (const [index, call] of batch.entries()) {
      const args = JSON.stringify(call.args)
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: ToolCallId(call.callId), name: call.name, argumentsDelta: args }
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: ToolCallId(call.callId), name: call.name, arguments: args },
      }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

type PolicyName = 'none' | 'replace-generating' | 'replace-publishing' | 'block-publishing'

/** One real Host with the production visual row and one live agent. */
interface Harness {
  readonly ctx: Context
  readonly sessionId: string
  readonly agent: {
    followup(message: unknown): void
    whenIdle(): Promise<void>
    session: { id: string; snapshotEvents(): readonly { type: string }[] }
  }
  readonly adapter: ScriptedAdapter
  /** Read committed durable events through the official observation lease. */
  observe(): Promise<VisualSessionEvent[]>
  /** Run one prompt through the real loop with the given step plan. */
  run(...steps: readonly StepPlan[]): Promise<void>
}

/** Install one real agent-scoped `tools/post-execute` policy. */
function installPolicy(agentCtx: Context, policy: PolicyName): void {
  if (policy === 'none') return
  agentCtx.on('tools/post-execute', async (exec, result, next) => {
    const generating = exec.name === CHART_TOOL_NAME || exec.name === SVG_TOOL_NAME
    const publishing = exec.name === PRESENT_VISUAL_TOOL_NAME
    if (policy === 'replace-generating' && generating) {
      await next()
      return { kind: 'accept', content: [{ type: 'text', text: 'REPLACED: the generating result was redacted' }] }
    }
    if (policy === 'replace-publishing' && publishing) {
      await next()
      return { kind: 'accept', content: [{ type: 'text', text: 'REPLACED: the publication result was redacted' }] }
    }
    if (policy === 'block-publishing' && publishing) return { kind: 'block', feedback: result.content }
    return next()
  })
}

/** Boot one real Host + agent with the production visual row mounted. */
async function boot(life: TestLifecycle, label: string, policy: PolicyName = 'none'): Promise<Harness> {
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, {})
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
  applyVisualTools(ctx, { enabled: { get: () => true } } as never)
  const sessionId = `${label}-${Math.random().toString(36).slice(2, 10)}`
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter([`visual-publication-${label}`], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId(sessionId) as never,
    agentOptions: { provider: `visual-publication-${label}`, model: 'm' },
    setup: (agentCtx: Context) => {
      if (process.env.DSH_DEBUG_VISUAL === '1') console.log('SETUP called, policy:', policy)
      installPolicy(agentCtx, policy)
    },
  })
  const agent = handle.agent as unknown as Harness['agent']
  return {
    ctx,
    sessionId,
    agent,
    adapter,
    observe: async function observe(): Promise<VisualSessionEvent[]> {
      const query = ctx.get('sessionQuery') as unknown as {
        observeSession(id: string, options: { projectionMode: 'none' }): Promise<{
          events: readonly { type: string }[]
          [Symbol.dispose](): void
        }>
      }
      const observation = await query.observeSession(sessionId, { projectionMode: 'none' })
      try {
        return observation.events as unknown as VisualSessionEvent[]
      } finally {
        observation[Symbol.dispose]()
      }
    },
    run: async function run(...steps: readonly StepPlan[]): Promise<void> {
      adapter.steps = [...steps]
      adapter.requests.length = 0
      if (process.env.DSH_DEBUG_VISUAL === '1') console.log('RUN agent status:', (agent as unknown as { status: string }).status, 'steps:', steps.length)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      if (process.env.DSH_DEBUG_VISUAL === '1') console.log('RUN done, requests:', adapter.requests.length, 'status:', (agent as unknown as { status: string }).status)
    },
  }
}

/** The durable `tool/result` entries, in order. */
function toolResults(events: readonly VisualSessionEvent[]): DurableResult[] {
  return events
    .filter((event): event is Extract<VisualSessionEvent, { type: 'tool/result' }> => event.type === 'tool/result')
    .map(event => ({
      callId: event.data.message.toolCallId,
      isError: event.data.message.isError === true,
      texts: event.data.message.content.filter(block => block.type === 'text').map(block => block.text),
    }))
}

/** The reference the MODEL actually received in one of its real requests. */
function modelVisibleRef(adapter: ScriptedAdapter): string {
  for (const request of adapter.requests) {
    const match = /visual-ref-v1:(sv1_[0-9a-f]{20})/u.exec(request.promptText)
    if (match !== null) return match[1] as string
  }
  throw new Error('the model never received a visual-ref-v1 line')
}

/** A step plan that publishes the model-visible reference it just read. */
function publishVisibleRef(callId = 'call-present'): StepPlan {
  return (request) => {
    const match = /visual-ref-v1:(sv1_[0-9a-f]{20})/u.exec(request.promptText)
    if (match === null) throw new Error('the publishing step did not receive the visual reference')
    return [{ callId, name: PRESENT_VISUAL_TOOL_NAME, args: { visuals: [{ ref: match[1] as string }] } }]
  }
}

/** A step plan that issues one generating call. */
function generate(callId: string, name: string, args: unknown): StepPlan {
  return () => [{ callId, name, args }]
}

// ── the positive path: model-visible ref -> durable publication ────────────

test('the model reads a committed chart reference and a later step publishes it durably', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'positive')
  // Step 0 generates the chart; step 1 (the SAME turn, a later step) publishes
  // the reference the real request text carried.
  await harness.run(generate('call-chart', CHART_TOOL_NAME, CHART_ARGS), publishVisibleRef())
  // Two tool-issuing steps follow each other, then a settling request closes
  // the turn; the exact count is not the contract, the available evidence is.
  assert.ok(harness.adapter.requests.length >= 2, 'both tool steps reached the model')

  const events = await harness.observe()
  const ref = modelVisibleRef(harness.adapter)
  const sources = collectVisualSources(harness.sessionId, events)
  assert.equal(sources.length, 1)
  assert.equal(sources[0]?.ref, ref, 'the model-visible ref is the durable source ref')
  assert.equal(sources[0]?.title, 'Request latency')

  const published = collectPublishedVisuals(harness.sessionId, events)
  assert.equal(published.length, 1, 'the real publication was accepted')
  assert.equal(published[0]?.ref, ref)
  assert.equal(published[0]?.callId, 'call-present')
  assert.equal(published[0]?.source.type, 'chart')

  // The durable receipt is the model-facing result of the publishing call.
  const publishResult = toolResults(events).find(result => result.callId === 'call-present')
  assert.ok(publishResult !== undefined)
  assert.equal(publishResult.isError, false)
  assert.equal(publishResult.texts.length, 2)
  assert.equal(publishResult.texts[0], 'Selected 1 visual for presentation.')
  assert.equal(
    publishResult.texts[1],
    `visual-published-v1:${JSON.stringify({ version: 1, published: [{ ref }] })}`,
  )
})

test('a real two-figure turn publishes both references in the requested order', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'two-figures')
  await harness.run(
    () => [
      { callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART_ARGS },
      { callId: 'call-svg', name: SVG_TOOL_NAME, args: SVG_ARGS },
    ],
    (request) => {
      const refs = [...request.promptText.matchAll(/visual-ref-v1:(sv1_[0-9a-f]{20})/gu)].map(match => match[1] as string)
      assert.equal(refs.length, 2, 'both references reached the model')
      return [{ callId: 'call-present', name: PRESENT_VISUAL_TOOL_NAME, args: { visuals: refs.map(ref => ({ ref })) } }]
    },
  )
  const events = await harness.observe()
  const published = collectPublishedVisuals(harness.sessionId, events)
  assert.equal(published.length, 2)
  assert.deepEqual(published.map(entry => entry.source.type), ['chart', 'svg'])
  assert.equal(published[1]?.source.svgSource, SVG_SOURCE, 'the SVG source stays the admitted durable call arguments')
})

test('the model sees the publication tool and the exact human values in its request', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'visibility')
  await harness.run(generate('call-chart', CHART_TOOL_NAME, CHART_ARGS))
  const first = harness.adapter.requests[0]
  assert.ok(first !== undefined)
  assert.ok(first.toolNames.includes(CHART_TOOL_NAME))
  assert.ok(first.toolNames.includes(SVG_TOOL_NAME))
  assert.ok(first.toolNames.includes(PRESENT_VISUAL_TOOL_NAME), 'present_visual is in the model catalog')
  // The generating result reaches the model in the NEXT request of the turn.
  const second = harness.adapter.requests[1]
  assert.ok(second !== undefined)
  assert.match(second.promptText, /visual-ref-v1:sv1_[0-9a-f]{20}/u, 'the reference is model-visible')
  assert.match(second.promptText, /p50 {2}42 ms/u, 'the exact human values stay readable')
})

// ── negative paths over the real loop ──────────────────────────────────────

test('a policy replacement of the generating result removes every qualification', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'replace-generating', 'replace-generating')
  await harness.run(generate('call-chart', CHART_TOOL_NAME, CHART_ARGS), () => [{
    callId: 'call-present',
    name: PRESENT_VISUAL_TOOL_NAME,
    args: { visuals: [{ ref: 'sv1_0123456789abcdef0123' }] },
  }])
  const events = await harness.observe()
  assert.deepEqual(collectVisualSources(harness.sessionId, events), [],
    'a replaced generating result is no source at all')
  assert.deepEqual(collectPublishedVisuals(harness.sessionId, events), [])
  const publishResult = toolResults(events).find(result => result.callId === 'call-present')
  assert.equal(publishResult?.isError, true, 'the publication had nothing to publish')
})

test('a policy replacement of the publication result makes the publication unreal', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'replace-publishing', 'replace-publishing')
  await harness.run(generate('call-chart', CHART_TOOL_NAME, CHART_ARGS), publishVisibleRef())
  const events = await harness.observe()
  assert.equal(collectVisualSources(harness.sessionId, events).length, 1, 'the source itself is intact')
  assert.deepEqual(collectPublishedVisuals(harness.sessionId, events), [],
    'a replaced publication result publishes nothing')
  const result = toolResults(events).find(entry => entry.callId === 'call-present')
  assert.match(result?.texts.join('\n') ?? '', /REPLACED/u)
})

test('a blocked publication result publishes nothing even though its feedback carries the receipt', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'block-publishing', 'block-publishing')
  await harness.run(generate('call-chart', CHART_TOOL_NAME, CHART_ARGS), publishVisibleRef())
  const events = await harness.observe()
  assert.deepEqual(collectPublishedVisuals(harness.sessionId, events), [])
  const result = toolResults(events).find(entry => entry.callId === 'call-present')
  assert.equal(result?.isError, true)
})

test('a publication requested by the generating step is refused by the real tool body', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'same-step')
  // BOTH calls are requested by ONE model step, so the publisher can only run
  // inside the generating step's own frame. The model cannot know the ref here,
  // so this case proves the STEP fence, not the reference identity.
  await harness.run(() => [
    { callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART_ARGS },
    { callId: 'call-present', name: PRESENT_VISUAL_TOOL_NAME, args: { visuals: [{ ref: 'sv1_0123456789abcdef0123' }] } },
  ])
  const events = await harness.observe()
  const result = toolResults(events).find(entry => entry.callId === 'call-present')
  assert.ok(result !== undefined)
  assert.equal(result.isError, true, 'a same-step publication never publishes')
  assert.deepEqual(collectPublishedVisuals(harness.sessionId, events), [])
})

test('a reference from an earlier turn is refused in the next turn', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'cross-turn')
  await harness.run(generate('call-chart', CHART_TOOL_NAME, CHART_ARGS))
  const ref = modelVisibleRef(harness.adapter)
  // A NEW prompt opens a NEW turn; the earlier source no longer qualifies.
  await harness.run(() => [{ callId: 'call-present', name: PRESENT_VISUAL_TOOL_NAME, args: { visuals: [{ ref }] } }])
  const events = await harness.observe()
  assert.deepEqual(collectPublishedVisuals(harness.sessionId, events), [])
  const result = toolResults(events).find(entry => entry.callId === 'call-present')
  assert.equal(result?.isError, true)
  assert.match(result?.texts.join('\n') ?? '', /belongs to turn/u)
})

test('a fabricated receipt from a non-visual tool publishes nothing', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'fabricated')
  // `bash` is not mounted in this fixture, so the call fails before producing any
  // content at all; the durable evidence is still not a publication.
  await harness.run(() => [{ callId: 'call-bash', name: 'bash', args: { command: 'echo hi' } }])
  const events = await harness.observe()
  assert.deepEqual(collectVisualSources(harness.sessionId, events), [])
  assert.deepEqual(collectPublishedVisuals(harness.sessionId, events), [])
})

// ── the durable content contract ───────────────────────────────────────────

test('the durable chart result keeps the human text plus both machine blocks', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'chart-durable')
  await harness.run(generate('call-chart', CHART_TOOL_NAME, CHART_ARGS))
  const events = await harness.observe()
  const result = toolResults(events).find(entry => entry.callId === 'call-chart')
  assert.ok(result !== undefined)
  assert.equal(result.texts.length, 3, 'human text, reference block, fact block')
  assert.match(result.texts[0] ?? '', /Request latency \(ms\)/u)
  assert.match(result.texts[0] ?? '', /p50 {2}42 ms/u)
  assert.match(result.texts[1] ?? '', /^visual-ref-v1:sv1_[0-9a-f]{20}$/u)
  assert.match(result.texts[2] ?? '', /^visual-v1:\{"version":1,"type":"chart"/u)
})

test('the durable SVG result keeps its credential and never duplicates the source', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'svg-durable')
  await harness.run(generate('call-svg', SVG_TOOL_NAME, SVG_ARGS))
  const events = await harness.observe()
  const sources = collectVisualSources(harness.sessionId, events)
  assert.equal(sources.length, 1)
  assert.equal(sources[0]?.type, 'svg')
  assert.deepEqual(sources[0]?.svg, svgFactFromArgs(SVG_ARGS))
  assert.equal(sources[0]?.svgSource, SVG_SOURCE)
  const result = toolResults(events).find(entry => entry.callId === 'call-svg')
  assert.ok(result !== undefined)
  assert.ok(result.texts.some(text => text.startsWith('visual-v1:')), 'the fact line is durable')
  assert.ok(result.texts.some(text => text.startsWith('visual-ref-v1:')), 'the reference line is durable')
  const factLine = result.texts.find(text => text.startsWith('visual-v1:')) as string
  assert.ok(!factLine.includes('<svg'), 'the result never duplicates the SVG source')
})

test('a second publication of the same reference keeps the FIRST occurrence', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'repeat')
  await harness.run(
    generate('call-chart', CHART_TOOL_NAME, CHART_ARGS),
    publishVisibleRef('present-1'),
    publishVisibleRef('present-2'),
  )
  const events = await harness.observe()
  const published = collectPublishedVisuals(harness.sessionId, events)
  assert.equal(published.length, 1, 'first-wins on the repeated reference')
  assert.equal(published[0]?.callId, 'present-1')
})
