/**
 * PR-D revised D0: the real AgentLoop + official `tools/post-execute`
 * waterfall against the two registered visual tools.
 *
 * The revised contract declares NO `presentationMeta`; this test proves the
 * F8R shape is absent on every path: no policy, content-only replacement,
 * value replacement and block all persist a `tool/result` WITHOUT an own
 * `meta` property. The content remains the single admission source.
 * @module @xmoon76/dsh-pi-tui/visual-tool-result-policy.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply as applyVisualTools, CHART_TOOL_NAME, SVG_TOOL_NAME } from '../../src/app/host/visual-tools.ts'
import { svgDigest, svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TranscriptToolMessage } from '../../src/domain/transcript/types.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import { TranscriptNodeKeys, transcriptView, type ToolSvgState } from '../../src/tui/tsp/transcript-view.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/><text x="4" y="20" font-size="12">Gateway</text></svg>'

type Policy = 'none' | 'content' | 'value' | 'block'

const CASES = {
  chart: {
    tool: CHART_TOOL_NAME,
    args: { kind: 'bars', title: 'Request latency', unit: 'ms', series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }] },
    replacement: {
      version: 1, type: 'chart', kind: 'spark', title: 'Replaced chart', unit: 'ms',
      series: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }],
    },
  },
  svg: {
    tool: SVG_TOOL_NAME,
    args: { title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE },
    replacement: {
      version: 1, type: 'svg', title: 'Replaced figure', description: 'replaced description',
      digest: svgDigest(`${SVG_SOURCE}<!-- replaced -->`), bytes: Buffer.byteLength(`${SVG_SOURCE}<!-- replaced -->`, 'utf8'),
    },
  },
}

class VisualAdapter extends LlmAdapter {
  calls = 0
  readonly requests: string[][] = []
  private readonly toolName: string
  private readonly args: string

  constructor(toolName: string, args: unknown) {
    super()
    this.toolName = toolName
    this.args = JSON.stringify(args)
  }

  override providerInfo(provider: string): { id: string; name: string } { return { id: provider, name: provider } }
  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider, id: 'm', name: 'M' }])
  }
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.requests.push(((options as unknown as { tools?: readonly { name: string }[] }).tools ?? []).map(tool => tool.name))
    if (this.calls === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call-visual-1'), name: this.toolName, argumentsDelta: this.args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call-visual-1'), name: this.toolName, arguments: this.args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function runCase(t: Parameters<typeof testLifecycle>[0], key: keyof typeof CASES, policy: Policy) {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, {})
  await mountAgentLoopTestHarness(ctx)
  applyVisualTools(ctx, { enabled: { get: () => true } } as never)
  const entry = CASES[key]
  const adapter = new VisualAdapter(entry.tool, entry.args)
  ctx.llm.registerAdapter(['visual-probe'], adapter)
  let callbackCount = 0
  const installPolicy = (agentCtx: Context): void => {
    if (policy === 'none') return
    agentCtx.on('tools/post-execute', async (_exec, result, next) => {
      callbackCount += 1
      // The hostile-but-official shape: a block whose feedback IS the original
      // visual content (including its valid machine line/credential). The
      // renderer must still refuse every drawing based on the result status.
      if (policy === 'block') return { kind: 'block', feedback: result.content }
      await next()
      if (policy === 'content') return { kind: 'accept', content: [{ type: 'text', text: 'REPLACED: the visual result was redacted by policy' }] }
      return { kind: 'accept', value: entry.replacement }
    })
  }
  const handle = await ctx.agents.create({
    sessionId: SessionId(`visual-policy-${key}-${policy}`) as never,
    agentOptions: { provider: 'visual-probe', model: 'm' },
    setup: installPolicy,
  })
  const agent = handle.agent as unknown as {
    followup(message: unknown): void
    whenIdle(): Promise<void>
    session: { snapshotEvents(): Array<{ type: string; data: Record<string, unknown> }> }
  }
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const header = events.find(event => event.type === 'request/header')
  const result = events.find(event => event.type === 'tool/result')
  const folder = new TranscriptFolder()
  folder.apply(events as never)
  const row = folder.messages().find(message => message.kind === 'tool' && message.name === entry.tool)
  return {
    modelTools: adapter.requests[0] ?? [],
    requestTools: ((header?.data as { header?: { tools?: Array<{ name?: string }> } } | undefined)?.header?.tools ?? []).map(tool => tool.name ?? null),
    callbackCount,
    hasMeta: result !== undefined && Object.hasOwn(result.data, 'meta'),
    isError: (result?.data as { message?: { isError?: boolean } } | undefined)?.message?.isError ?? null,
    text: ((result?.data as { message?: { content?: Array<{ text?: string }> } } | undefined)?.message?.content ?? []).map(block => block.text ?? null),
    foldedHasMeta: row !== undefined && (row as { meta?: unknown }).meta !== undefined,
    tool: row as TranscriptToolMessage | undefined,
  }
}

test('the registered visual tools persist no presentation meta under every post-execute decision', async (t) => {
  for (const key of ['chart', 'svg'] as const) {
    for (const policy of ['none', 'content', 'value', 'block'] as const) {
      const row = await runCase(t, key, policy)
      assert.ok(row.modelTools.includes(CASES[key].tool), `${key}/${policy}: the model must see the tool`)
      assert.ok(row.requestTools.includes(CASES[key].tool), `${key}/${policy}: the first request header must carry the tool`)
      assert.equal(row.hasMeta, false, `${key}/${policy}: durable tool/result must not have an own meta property`)
      assert.equal(row.foldedHasMeta, false, `${key}/${policy}: the fold must not invent meta`)
      if (policy === 'none') {
        assert.equal(row.callbackCount, 0)
        assert.equal(row.isError, false)
        assert.match(JSON.stringify(row.text), key === 'chart' ? /Request latency/u : /Service topology/u)
      }
      if (policy === 'content') {
        assert.equal(row.callbackCount, 1)
        assert.equal(row.isError, false)
        assert.match(JSON.stringify(row.text), /REPLACED/u)
        assert.doesNotMatch(JSON.stringify(row.text), /visual-v1:/u)
      }
      if (policy === 'value') {
        assert.equal(row.callbackCount, 1)
        assert.equal(row.isError, false)
        assert.match(JSON.stringify(row.text), /Replaced/u)
      }
      if (policy === 'block') {
        assert.equal(row.callbackCount, 1)
        assert.equal(row.isError, true)
        // The block feedback is the ORIGINAL visual content; it must remain
        // readable but must never become a drawing.
        assert.match(JSON.stringify(row.text), key === 'chart' ? /Request latency/u : /Service topology/u)
        const tool = row.tool
        assert.ok(tool !== undefined)
        const svgFact = key === 'svg'
          ? (() => {
            const args = CASES.svg.args as { title: string; description: string; svg: string }
            return svgFactFromArgs(args)
          })()
          : undefined
        const ready: ReadonlyMap<TranscriptToolMessage, ToolSvgState> | undefined = svgFact === undefined
          ? undefined
          : new Map([[tool, {
            state: 'ready', blobId: 'f'.repeat(64), request: () => 'f'.repeat(64), fact: svgFact, source: CASES.svg.args.svg,
          }]])
        const view = transcriptView(projectTranscriptStructure([tool]), new TranscriptNodeKeys(), {
          chartKindsSupported: true,
          ...(ready === undefined ? {} : { toolSvgStates: ready }),
        })
        const kinds: string[] = []
        const walk = (node: { kind: string; children: readonly unknown[] }): void => {
          kinds.push(node.kind)
          for (const child of node.children) walk(child as { kind: string; children: readonly unknown[] })
        }
        for (const child of (view as unknown as { children: readonly unknown[] }).children) walk(child as { kind: string; children: readonly unknown[] })
        assert.equal(kinds.includes('chart'), false, `${key}: a blocked result must not emit a chart node`)
        assert.equal(kinds.includes('image'), false, `${key}: a blocked result must not emit an image node`)
      }
    }
  }
})

/** The visual node kinds a folded tool row produces through the real TSP
 *  projection (chart for charts; image for an adopted native SVG). */
function renderedVisualKinds(tool: TranscriptToolMessage, key: 'chart' | 'svg'): string[] {
  const view = key === 'svg'
    ? (() => {
        const fact = svgFactFromArgs(CASES.svg.args)
        const ready: ReadonlyMap<TranscriptToolMessage, ToolSvgState> = new Map([[tool, {
          state: 'ready',
          blobId: 'f'.repeat(64),
          request: () => 'f'.repeat(64),
          fact,
          source: CASES.svg.args.svg,
        }]])
        return transcriptView(projectTranscriptStructure([tool]), new TranscriptNodeKeys(), {
          chartKindsSupported: true,
          toolSvgStates: ready,
        })
      })()
    : transcriptView(projectTranscriptStructure([tool]), new TranscriptNodeKeys(), { chartKindsSupported: true })
  const kinds: string[] = []
  const walk = (node: { kind: string; children: readonly unknown[] }): void => {
    kinds.push(node.kind)
    for (const child of node.children) walk(child as { kind: string; children: readonly unknown[] })
  }
  for (const child of (view as unknown as { children: readonly unknown[] }).children) {
    walk(child as { kind: string; children: readonly unknown[] })
  }
  return kinds
}

test('turning the switch Off leaves an already-recorded chart/SVG result fully renderable', async (t) => {
  for (const key of ['chart', 'svg'] as const) {
    const life = testLifecycle(t)
    const ctx = new Context()
    life.defer(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx, {})
    await mountAgentLoopTestHarness(ctx)
    let enabled = true
    applyVisualTools(ctx, { enabled: { get: () => enabled } } as never)
    const entry = CASES[key]
    const adapter = new VisualAdapter(entry.tool, entry.args)
    ctx.llm.registerAdapter(['visual-off-history'], adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId(`visual-off-history-${key}`) as never,
      agentOptions: { provider: 'visual-off-history', model: 'm' },
    })
    const agent = handle.agent as unknown as {
      followup(message: unknown): void
      whenIdle(): Promise<void>
      session: { snapshotEvents(): Array<{ type: string; data: Record<string, unknown> }> }
    }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const original = new TranscriptFolder()
    original.apply(events as never)
    const recorded = original.messages().find(message => message.kind === 'tool' && message.name === entry.tool) as TranscriptToolMessage | undefined
    assert.ok(recorded !== undefined, `${key}: the durable tool row must exist before the switch changes`)
    assert.match(recorded.result, key === 'chart' ? /p50 {2}42/u : /Service topology/u)
    assert.ok(renderedVisualKinds(recorded, key).includes(key === 'chart' ? 'chart' : 'image'),
      `${key}: the recorded result renders while the tools are registered`)

    // THE SWITCH TURNS OFF ONLY NOW: the durable result already exists.
    enabled = false
    ctx.emit('loader/volatile-update', [['enabled']])
    assert.equal(ctx.tools.get(entry.tool), undefined, `${key}: the switch really unregistered the tool`)
    assert.equal(ctx.tools.get(key === 'chart' ? SVG_TOOL_NAME : CHART_TOOL_NAME), undefined)

    // Reopening the session folds the SAME durable events again. No consumer
    // may re-filter a recorded drawing by the live switch value.
    const replayed = new TranscriptFolder()
    replayed.apply(events as never)
    const replay = replayed.messages().find(message => message.kind === 'tool' && message.name === entry.tool) as TranscriptToolMessage | undefined
    assert.ok(replay !== undefined, `${key}: the durable row survives a fresh fold after Off`)
    assert.equal(replay.result, recorded.result, `${key}: the durable result is byte-identical after Off`)
    const kinds = renderedVisualKinds(replay, key)
    assert.ok(kinds.includes(key === 'chart' ? 'chart' : 'image'),
      `${key}: the recorded drawing still renders after the switch is Off (kinds: ${kinds.join(', ')})`)
    assert.match(replay.result, key === 'chart' ? /p99 {2}70/u : /SVG source available/u,
      `${key}: the readable values/source credential remain exportable`)
  }
})
