/**
 * Real-DSH producer integration for the Working Context carriage contract.
 *
 * Chain per case (no hand-written `sameTurnNextStep`):
 *
 *   scripted LLM request
 *     -> the REAL pinned DSH AgentLoop
 *     -> the REAL repeat-tool-reminder Guard / the REAL `tool-executor-ptc`
 *     -> the official `agent/inbox/spliced` insert+claim and durable
 *        `user/message`
 *     -> the production `TranscriptFolder` and canonical Work structure
 *
 * FIXTURE MANIFEST
 * - REAL: `mountAgentLoopTestDependencies` + `mountAgentLoopTestHarness`, the
 *   real tool runtime, the official repeat-tool-reminder Guard, the official
 *   PTC executor, the official Node PTC runtime and its sandbox/subprocess
 *   prerequisites where the case needs them.
 * - STAND-INS: the scripted `LlmAdapter` (the model), a controlled
 *   `image_probe` tool body, and disposable test roots.
 * - ABSENT: a physical terminal, a Tern pane and a real user DSH_HOME.
 * @module @xmoon76/dsh-pi-tui/working-context-producer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage, type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const requireFromBase = createRequire(requireFromBasePath())
function requireFromBasePath(): string {
  return createRequire(import.meta.url).resolve('@deepseek-ai/dsh-base/package.json')
}

/** Mount a dynamically imported official plugin through the one Cordis entry;
 * the runtime module has no local declaration graph, so the plugin shape is
 * intentionally structural here. */
async function mountPlugin(ctx: Context, plugin: unknown, config?: unknown): Promise<void> {
  await (ctx.plugin as unknown as (plugin: unknown, config?: unknown) => Promise<unknown>)(plugin, config)
}

async function importFromBase(id: string): Promise<Record<string, unknown>> {
  const resolved = requireFromBase.resolve(id)
  return await import(pathToFileURL(resolved).href) as Record<string, unknown>
}

interface ScriptedCall {
  readonly callId: string
  readonly name: string
  readonly args: unknown
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: string[] = []
  steps: Array<() => readonly ScriptedCall[]> = []
  override providerInfo(provider: string): { id: string; name: string } { return { id: provider, name: provider } }
  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider, id: 'm', name: 'M' }])
  }
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(JSON.stringify(options.messages ?? []))
    const plan = this.steps[this.requests.length - 1]
    const batch = plan === undefined ? [] : plan()
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

interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly agent: {
    followup(message: unknown): void
    whenIdle(): Promise<void>
    session: { id: string; snapshotEvents(): readonly SessionEvent[] }
  }
  run(...steps: readonly (() => readonly ScriptedCall[])[]): Promise<void>
}

async function boot(
  life: TestLifecycle,
  label: string,
  mode: 'native' | 'ptc',
  setup?: (ctx: Context) => Promise<void>,
): Promise<Harness> {
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode } })
  await mountAgentLoopTestHarness(ctx)
  if (setup !== undefined) await setup(ctx)
  const adapter = new ScriptedAdapter()
  const provider = `working-context-${label}`
  ctx.llm.registerAdapter([provider], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId(`${label}-${Math.random().toString(36).slice(2, 10)}`) as never,
    agentOptions: { provider, model: 'm' },
  })
  const agent = handle.agent as unknown as Harness['agent']
  return {
    ctx,
    adapter,
    agent,
    run: async function run(...steps): Promise<void> {
      adapter.steps = [...steps]
      adapter.requests.length = 0
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
  }
}

function eventTexts(events: readonly SessionEvent[], type: string): string[] {
  return events
    .filter(event => event.type === type)
    .map(event => JSON.stringify(event.data))
}

test('the REAL repeat-tool-reminder Guard produces a claimed same-turn durable delivery', async (t) => {
  const life = testLifecycle(t)
  const repeatPlugin = await importFromBase('@deepseek-ai/dsh-repeat-tool-reminder')
  const harness = await boot(life, 'reminder', 'native', async (ctx) => {
    await mountPlugin(ctx, repeatPlugin, { thresholds: [2] })
    ctx.tools.register(defineContentToolFixture({
      name: 'repeat_probe',
      description: 'returns a fixed result so the model can repeat the exact call',
      parameters: {},
      execute: async () => [{ type: 'text', text: 'same result' }],
    }))
  })
  const repeated = () => [{ callId: 'repeat-call', name: 'repeat_probe', args: {} }] as const
  await harness.run(
    () => [repeated()[0], { ...repeated()[0], callId: 'repeat-call-2' }],
    () => [],
  )
  const events = harness.agent.session.snapshotEvents()
  const reminderMessages = events.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.type === 'user/message'
    && (event.data.source as { kind?: string }).kind === 'repeat-tool-reminder')
  assert.equal(reminderMessages.length, 1, 'the real Guard produced one durable reminder')
  const message = reminderMessages[0]!.data
  assert.equal((message.source as { form?: string }).form, 'notice')
  assert.match(JSON.stringify(message.content), /repeating the exact same tool call/u)
  // The reminder reached the NEXT REAL model request (same-turn consumption).
  assert.ok(harness.adapter.requests.some(request => request.includes('repeating the exact same tool call')),
    'the model received the reminder within the same turn')
  // The durable inbox chain proves the same-turn next-step claim.
  assert.ok(eventTexts(events, 'agent/inbox/spliced').some(text => text.includes('repeat-tool-reminder')),
    'the durable inbox splice carries the reminder identity')

  const folder = new TranscriptFolder()
  folder.hydrate(events)
  const messages = folder.messages()
  const context = messages.find(row => row.kind === 'system'
    && row.contextPresentation?.sourceKind === 'repeat-tool-reminder')
  assert.ok(context !== undefined && context.kind === 'system')
  assert.equal(context.contextPresentation?.sameTurnNextStep, true, 'the production fold proves the same-turn claim')
  const structure = projectTranscriptStructure(messages)
  assert.equal(structure.filter(block => block.kind === 'work').length, 1,
    'the real reminder is carried by the one same-turn Work')
  const span = structure.find(block => block.kind === 'work')
  assert.ok(span?.kind === 'work' && span.span.members.includes(context))

  // Negative control: the SAME real producer message replayed WITHOUT its
  // durable claim chain stays an independent Context boundary.
  const unclaimed = new TranscriptFolder()
  unclaimed.apply([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } } as SessionEvent,
    { type: 'tool/call', seq: 1, time: 2, data: { turn: 0, step: 0, callId: ToolCallId('unclaimed-a'), name: 'repeat_probe', arguments: '{}' } } as SessionEvent,
    { type: 'tool/result', seq: 2, time: 3, data: { turn: 0, step: 0, message: { id: 'unclaimed-r1', role: 'tool', toolCallId: 'unclaimed-a', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool' } } } } as never,
    { type: 'user/message', seq: 3, time: 4, data: message } as SessionEvent,
  ])
  const unclaimedRow = unclaimed.messages().find(row => row.kind === 'system')
  assert.ok(unclaimedRow !== undefined && unclaimedRow.kind === 'system')
  assert.equal(unclaimedRow.contextPresentation?.sameTurnNextStep, undefined,
    'the same producer source without the durable claim fails open')
})

test('the REAL PTC executor emits an image-bearing same-turn Context that the production fold carries', async (t) => {
  const life = testLifecycle(t)
  const NodePtcRuntime = (await importFromBase('@deepseek-ai/dsh-ptc-runtime-node')).default as never
  const harness = await boot(life, 'ptc', 'ptc', async (ctx) => {
    await mountPlugin(ctx, SubprocessLocal, {})
    await mountPlugin(ctx, SandboxLocal, {})
    await mountPlugin(ctx, SandboxPolicy, {})
    await mountPlugin(ctx, NodePtcRuntime, { executionMode: 'per-call', timeoutMs: 20_000 })
    ctx.tools.register(defineContentToolFixture({
      name: 'image_probe',
      description: 'returns one image block for the PTC nested dispatch',
      parameters: {},
      execute: async () => ([{
        type: 'image',
        attachment: {
          attachmentId: 'producer-image-1',
          mediaType: 'image/png',
          bytes: 4,
          width: 2,
          height: 2,
          name: 'nested.png',
        },
      }] as unknown as ContentBlock[]),
    }))
  })
  await harness.run(
    () => [{
      callId: 'ptc-run-code',
      name: 'run_code',
      args: {
        code: 'return await tools.image_probe({})',
        description: 'Run the image probe',
      },
    }],
    () => [],
  )
  const events = harness.agent.session.snapshotEvents()
  const ptcMessages = events.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.type === 'user/message'
    && (event.data.source as { kind?: string }).kind === 'ptc-mode')
  assert.equal(ptcMessages.length, 1, 'the real PTC executor deferred one image Context')
  const message = ptcMessages[0]!.data
  const blocks = message.content as readonly { type: string }[]
  assert.equal(blocks.some(block => block.type === 'image'), true, 'the deferred Context carries the real image block')
  assert.ok(eventTexts(events, 'agent/inbox/spliced').some(text => text.includes('ptc-mode')),
    'the image Context entered the durable same-turn inbox chain')

  const folder = new TranscriptFolder()
  folder.hydrate(events)
  const messages = folder.messages()
  const context = messages.find(row => row.kind === 'system' && row.contextPresentation?.sourceKind === 'ptc-mode')
  assert.ok(context !== undefined && context.kind === 'system')
  assert.equal(context.contextPresentation?.sameTurnNextStep, true, 'the production fold proves the same-turn claim')
  assert.deepEqual(context.content?.map(block => block.type), ['image'])
  const structure = projectTranscriptStructure(messages)
  assert.equal(structure.filter(block => block.kind === 'work').length, 1,
    'the real PTC image Context is carried by the one same-turn Work')
  const span = structure.find(block => block.kind === 'work')
  assert.ok(span?.kind === 'work' && span.span.members.includes(context))

  // Negative control: the SAME real producer message replayed WITHOUT its
  // durable claim chain stays an independent Context boundary.
  const unclaimed = new TranscriptFolder()
  unclaimed.apply([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } } as SessionEvent,
    { type: 'tool/call', seq: 1, time: 2, data: { turn: 0, step: 0, callId: ToolCallId('unclaimed-ptc'), name: 'run_code', arguments: '{}' } } as SessionEvent,
    { type: 'tool/result', seq: 2, time: 3, data: { turn: 0, step: 0, message: { id: 'unclaimed-ptc-r1', role: 'tool', toolCallId: 'unclaimed-ptc', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool' } } } } as never,
    { type: 'user/message', seq: 3, time: 4, data: message } as SessionEvent,
  ])
  const unclaimedRow = unclaimed.messages().find(row => row.kind === 'system')
  assert.ok(unclaimedRow !== undefined && unclaimedRow.kind === 'system')
  assert.equal(unclaimedRow.contextPresentation?.sameTurnNextStep, undefined,
    'the same PTC image Context without the durable claim fails open')
})
