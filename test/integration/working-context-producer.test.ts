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
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import { summarizeWorkSpan } from '../../src/tui/transcript/work-summary.ts'
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
    inject(message: unknown): void
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

test('the REAL skill-catalog producer publishes a complete same-turn update that one Work carries', async (t) => {
  const life = testLifecycle(t)
  const harness = await boot(life, 'catalog', 'native', async (ctx) => {
    await mountPlugin(ctx, SkillRegistry)
    await mountPlugin(ctx, toolSkill)
    ctx.skills.register({
      name: 'alpha-catalog-skill',
      description: 'First deterministic catalog skill.',
      source: 'runtime',
      content: 'Alpha body.',
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'catalog_refresh_probe',
      description: 'registers a second real skill and returns a normal result',
      parameters: {},
      execute: async () => {
        ctx.skills.register({
          name: 'beta-catalog-skill',
          description: 'Second deterministic catalog skill.',
          source: 'runtime',
          content: 'Beta body.',
        })
        return [{ type: 'text', text: 'catalog refreshed' }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'after_catalog_probe',
      description: 'returns a normal result after the catalog update',
      parameters: {},
      execute: async () => [{ type: 'text', text: 'after catalog' }],
    }))
  })
  await harness.run(
    () => [{ callId: 'catalog-refresh-call', name: 'catalog_refresh_probe', args: {} }],
    () => [{ callId: 'after-catalog-call', name: 'after_catalog_probe', args: {} }],
    () => [],
  )
  const events = harness.agent.session.snapshotEvents()
  const catalogs = events.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.type === 'user/message'
    && (event.data.source as { kind?: string }).kind === 'skill-catalog')
  assert.equal(catalogs.length, 2, 'the real producer published one initial catalog and one complete update')
  const initial = catalogs[0]!.data
  const updated = catalogs[1]!.data
  const initialSource = initial.source as { update?: unknown; incomplete?: unknown; entries: readonly { name: string }[] }
  const updatedSource = updated.source as { update?: unknown; incomplete?: unknown; entries: readonly { name: string }[] }
  assert.equal(initialSource.update, undefined, 'the first publication is not an update')
  assert.equal(Object.hasOwn(updatedSource, 'incomplete'), false, 'the replacement is a COMPLETE discovery')
  assert.equal(updatedSource.update, true)
  assert.deepEqual(initialSource.entries.map(entry => entry.name), ['alpha-catalog-skill'])
  assert.deepEqual(updatedSource.entries.map(entry => entry.name), ['alpha-catalog-skill', 'beta-catalog-skill'])

  // No fabricated inbox identity: the catalog arrives as a direct pre-step
  // append, never through the next-step insert/claim chain.
  const inboxText = eventTexts(events, 'agent/inbox/spliced').join('\n')
  assert.equal(inboxText.includes(initial.id), false, 'the initial catalog is not an inbox item')
  assert.equal(inboxText.includes(updated.id), false, 'the update is not an inbox item')

  // Exact causal position: the update lands in the SAME open turn AFTER the
  // first real tool result and BEFORE the second tool call/request.
  const updatedIndex = events.indexOf(catalogs[1]!)
  const firstResultIndex = events.findIndex(event => event.type === 'tool/result')
  const secondCallIndex = events.findIndex((event, index) => index > firstResultIndex && event.type === 'tool/call')
  assert.ok(firstResultIndex >= 0 && secondCallIndex > firstResultIndex, 'fixture: both real tool calls/results landed')
  assert.ok(updatedIndex > firstResultIndex && updatedIndex < secondCallIndex,
    'the complete update is admitted after the first real Process result and before the second request')
  const turnStarts = events.filter(event => event.type === 'turn/start')
  const turnEnds = events.filter(event => event.type === 'turn/end')
  assert.equal(turnStarts.length, 1)
  assert.equal(turnEnds.length, 1)
  assert.ok(events.indexOf(turnStarts[0]!) < updatedIndex && updatedIndex < events.indexOf(turnEnds[0]!))

  const folder = new TranscriptFolder()
  folder.hydrate(events)
  const messages = folder.messages()
  const catalogRows = messages.filter((row): row is Extract<TranscriptMessage, { kind: 'system' }> => row.kind === 'system'
    && row.contextPresentation?.sourceKind === 'skill-catalog')
  assert.equal(catalogRows.length, 2)
  const [initialRow, updatedRow] = catalogRows
  assert.ok(initialRow !== undefined && updatedRow !== undefined)
  assert.equal(initialRow.contextPresentation?.completeCatalogUpdate, undefined)
  assert.equal(initialRow.contextPresentation?.sameTurnNextStep, undefined)
  assert.equal(updatedRow.contextPresentation?.completeCatalogUpdate, true,
    'the fold records the complete replacement as one source fact')
  assert.equal(updatedRow.contextPresentation?.sameTurnNextStep, undefined,
    'a direct pre-step append is not an inbox claim')

  const structure = projectTranscriptStructure(messages)
  const works = structure.filter(block => block.kind === 'work')
  assert.equal(works.length, 1, 'the complete update does not split the one real same-turn Activity')
  const span = works[0]!.span
  assert.ok(span.members.includes(updatedRow), 'the complete update is carried by the real Work')
  assert.equal(span.members.includes(initialRow), false, 'the initial catalog stays an independent boundary')
  assert.ok(span.members.indexOf(updatedRow) > span.members.indexOf(messages.find(row => row.kind === 'tool' && row.name === 'catalog_refresh_probe')!),
    'the carried update keeps its raw position after the first real result')
  assert.equal(summarizeWorkSpan(span).actionStats.total, 2, 'the catalog adds no Action')
})

test('a real pre-step rejection appends nothing and the next prompt is an independent admission', async (t) => {
  const life = testLifecycle(t)
  const rejected = createUserMessage({
    content: [{ type: 'text', text: 'REJECTED_SAME_TURN_BODY' }],
    source: { kind: 'system-prompt', form: 'notice', summary: 'rejected goal round' },
  })
  let rejectedOnce = false
  let injectRejected: () => void = () => {}
  const harness = await boot(life, 'reject', 'native', async (ctx) => {
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (!rejectedOnce && decision.messages.some(message => message.id === rejected.id)) {
        rejectedOnce = true
        return { kind: 'reject' as const }
      }
      return decision
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'reject_probe',
      description: 'injects one next-step message that the real pre-step rejects',
      parameters: {},
      execute: async () => {
        injectRejected()
        return [{ type: 'text', text: 'reject probe result' }]
      },
    }))
  })
  injectRejected = () => harness.agent.inject(rejected)
  await harness.run(() => [{ callId: 'reject-call', name: 'reject_probe', args: {} }], () => [])
  assert.equal(rejectedOnce, true, 'the real pre-step waterfall rejected the claimed identity')
  const firstEvents = harness.agent.session.snapshotEvents()
  assert.equal(firstEvents.some(event => event.type === 'user/message' && event.data.id === rejected.id), false,
    'the rejected claimed identity never materialized as a user/message')
  const splices = firstEvents.filter(event => event.type === 'agent/inbox/spliced')
  assert.ok(splices.some(event => JSON.stringify(event.data.inserted).includes(rejected.id)),
    'the fixture produced the real next-step insertion')
  const claim = splices.find(event => {
    const data = event.data
    return data.target === 'next-step' && data.start === 0 && data.removedCount === 1
      && Array.isArray(data.inserted) && data.inserted.length === 0 && data.outcome === undefined
  })
  assert.ok(claim !== undefined, 'the fixture produced the official full-drain claim')
  assert.equal(firstEvents.filter(event => event.type === 'turn/end').length, 1,
    'the rejected claim does not prevent the owning turn from closing')

  // A later independent prompt is a new ordinary admission; it does not
  // resurrect the rejected identity or its claimed provenance.
  await harness.run(() => [])
  const events = harness.agent.session.snapshotEvents()
  assert.equal(events.filter(event => event.type === 'turn/start').length, 2)
  assert.equal(events.filter(event => event.type === 'turn/end').length, 2)
  assert.equal(events.some(event => event.type === 'user/message' && event.data.id === rejected.id), false)
  const folder = new TranscriptFolder()
  folder.hydrate(events)
  assert.equal(folder.messages().some(row => row.kind === 'system' && row.text.includes('REJECTED_SAME_TURN_BODY')), false,
    'the rejected claimed identity never appears as a Context row')
})
