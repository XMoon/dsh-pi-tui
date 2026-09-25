/**
 * rc.2 dynamic tool-registry change through the production Plugin Manager seam
 * (implementation plan §13).
 *
 * A real DSH AgentLoop + Session + tool runtime runs against a recording LLM
 * adapter. A live tool-registry change is dispatched through the production
 * semantic seam (`PluginManagerController` → `DirectPluginManagerPort` →
 * official `pluginManager.setBundleEnabled`), and the Host service double
 * registers exactly one new tool — the same registry change an installed
 * profile produces when a tool source changes. The SAME Agent/Session then
 * sends its next request, and the proof is that:
 *
 * - the request/tool projection contains the newly registered tool;
 * - the Session records the official `developer/message` tool-addition;
 * - `Session.toolHistory()` — the DSH-owned fold — reflects the update;
 * - the Agent/Session identity never changed (no recreation).
 *
 * Scope note: this isolates the Agent-loop dynamic-tool behavior plus the TUI
 * dispatch seam. In a real installed profile, rc.2 reports `restart-required`
 * for a Plugin Manager bundle/plugin-row toggle rather than hot-applying it,
 * and the TUI presents that outcome; there is no "hot-enable without Session
 * recreation" claim here.
 *
 * @module @xmoon76/dsh-pi-tui/plugin-manager-live-tool.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { PluginManagerController } from '../src/plugin-manager/controller.ts'
import { bundleValue } from '../src/plugin-manager/model.ts'
import { createDiag } from '../src/diag.ts'
import { DirectPluginManagerPort } from '../src/runtime/direct/plugin-manager-direct.ts'

const PROBE_TOOL = 'rc2_live_tool_probe'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A recording adapter that answers every request with one text response. */
class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of textResponse('ok')) yield chunk
  }
}

interface LoopHarness {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: RecordingAdapter
  readonly registerProbe: () => () => void
}

async function mountLoop(): Promise<LoopHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('live-tool'), { provider: 'mock', model: 'model' })
  return {
    ctx,
    agent,
    adapter,
    registerProbe: () => ctx.tools.register(defineContentToolFixture({
      name: PROBE_TOOL,
      description: 'probe tool',
      parameters: {},
      execute: async () => [{ type: 'text', text: 'probe done' }],
    })),
  }
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function fakePluginManager(onEnable: () => void): Record<string, unknown> {
  return {
    listBundles: async () => [{
      name: 'probe-bundle',
      enabled: false,
      installed: true,
      optional: false,
      removable: true,
      rows: [],
      overrides: [],
    }],
    listPlugins: async () => [],
    registries: async () => ({ registry: null, fallbackRegistries: [], resolved: null }),
    listVersionExemptions: () => ({ exemptions: {}, warnings: [] }),
    inspect: async () => ({ status: 'refused', problem: 'unknown', reason: 'not used' }),
    setBundleEnabled: async () => { onEnable(); return { changed: true, application: 'applied', stage: 'enable', target: 'probe-bundle' } },
    setPluginEnabled: async () => { onEnable(); return { changed: true, application: 'applied', stage: 'enable', target: 'probe-entry' } },
    removeBundle: async () => ({ changed: false, application: 'applied', stage: 'remove', target: '' }),
    installBundle: async () => ({ changed: false, application: 'applied', stage: 'install', target: '' }),
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
  }
}

async function tick(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** Select one bundle card by its semantic value through the real controller. */
function select(controller: PluginManagerController, value: string): void {
  for (let index = 0; index < controller.rows().length + 1; index += 1) {
    if (controller.selectedValue() === value) return
    controller.move(1)
  }
  assert.fail(`plugin manager row ${value} was not selectable`)
}

function toolNames(agent: Agent): readonly string[] {
  return agent.session.requestHeader()?.tools?.map(schema => schema.name) ?? []
}

function developerContent(agent: Agent): readonly (readonly { type: string; toolName: string }[])[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'developer/message')
    .map(event => (event.data as { message: { content: readonly { type: string; toolName: string }[] } }).message.content)
}

test('a live tool-registry change through the production Plugin Manager seam reaches the next request on the SAME Session', async () => {
  const { ctx, agent, adapter, registerProbe } = await mountLoop()
  const sessionId = agent.session.id

  // Request 1: the probe tool is not registered yet.
  await send(agent, 'first')
  assert.deepEqual(toolNames(agent), [], 'the probe tool is absent from the first request')
  assert.deepEqual(adapter.requests[0]?.tools?.map(schema => schema.name) ?? [], [])

  // Dispatch through the FULL production chain: the TUI controller calls the
  // Direct port, which calls the official mutation. Only the official Host
  // service is faked — its setBundleEnabled performs the live registry change.
  // (An installed profile's rc.2 Host reports `restart-required` for a bundle
  // toggle instead; the TUI presents that outcome there.)
  ctx.provide('pluginManager', fakePluginManager(registerProbe) as never)
  const port = new DirectPluginManagerPort(ctx as never)
  const controller = new PluginManagerController(port, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  controller.open('direct-command')
  await tick()
  select(controller, bundleValue('probe-bundle'))
  await controller.toggleSelectedCard()
  await tick()

  // Request 2 on the SAME Agent/Session.
  await send(agent, 'second')
  assert.equal(agent.session.id, sessionId, 'the Session identity never changed')
  assert.deepEqual(toolNames(agent), [PROBE_TOOL], 'the next request declares the newly enabled tool')
  assert.ok(adapter.requests[1]?.tools?.some(schema => schema.name === PROBE_TOOL))

  // The official durable tool history is the owner — never the TUI.
  const updates = developerContent(agent)
  assert.equal(updates.length, 1, 'the Agent loop recorded exactly one tool update')
  assert.deepEqual(updates[0], [{ type: 'tool-addition', toolName: PROBE_TOOL }])
  assert.ok(agent.session.toolHistory().updates.some(update => update.additions.some(schema => schema.name === PROBE_TOOL)),
    'Session.toolHistory() is the DSH-owned fold and reflects the addition')
})

test('a disable through the tool registry records the official removal on the same Session', async () => {
  const { agent, adapter, registerProbe } = await mountLoop()
  // Start with the probe active (registered before the first request).
  const disposeProbe = registerProbe()
  await send(agent, 'first')
  assert.ok(adapter.requests[0]?.tools?.some(schema => schema.name === PROBE_TOOL))

  disposeProbe()
  await send(agent, 'second')
  assert.equal(agent.session.id, 'live-tool', 'the Session identity never changed')
  assert.ok(!toolNames(agent).includes(PROBE_TOOL), 'the next request no longer declares the removed tool')
  const updates = developerContent(agent)
  assert.ok(updates.some(content => content.some(block => block.type === 'tool-removal' && block.toolName === PROBE_TOOL)),
    'the removal is recorded as an official developer tool update')
})
