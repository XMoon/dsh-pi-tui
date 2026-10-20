/**
 * The official subagent model-selection CLOSED LOOP (the review's P2 gate):
 * the TUI writes the official `subagent-model-selection` section, and a NEW
 * standard-composed Session's `subagent` tool must actually expose
 * provider/model/reasoning_effort plus `list_subagent_models` — the exact
 * capability that supersedes the legacy `subagent_route` routing. The stack
 * is the REAL 0.1.7 host: the subagentModelSelection config service,
 * the Agent registry, the
 * subagent runtime with the in-process spawn provider, and the real
 * tool-subagent plugin mounted with `modelSelectionSettings: true` (the
 * standard preset's row).
 *
 * Sampling is per Agent publication (upstream contract): a settings change
 * never rewrites an already-composed Session, and a composed Session keeps
 * its durable sampled policy across later setting flips.
 * @module @xmoon76/dsh-pi-tui/subagent-model-selection-composition.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { ToolCallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as tool from '@deepseek-ai/dsh-tool-subagent'
import SubagentModelSelectionConfig from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'

const ALLOWED_MODELS = [{ provider: 'alpha', model: 'fast' }]

/** Whether one Agent's delegation definition carries the route fields. */
function selectable(ctx: Context, agent: Agent): boolean {
  const schema = ctx.tools.schemas(agent).find(candidate => candidate.name === 'subagent')
  const properties = (schema?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  return properties?.['provider'] !== undefined
    && properties['model'] !== undefined
    && properties['reasoning_effort'] !== undefined
    && ctx.tools.schemas(agent).some(candidate => candidate.name === 'list_subagent_models')
}

type SubagentModelSelectionFiber = Awaited<ReturnType<Context['plugin']>>
type PresetScope = ReturnType<typeof createScope>

/** Mount the real Agent, provider, and tool services with the official
 * model-selection service composed at one preference value. The preference
 * lives on the service's own plugin Config: `remount` swaps the service
 * instance AND the standing preset composition the NEXT session samples,
 * exactly like a settings edit followed by the next composition.
 *
 * 0.2.1-rc.2 shape: `modelSelectionSettings` samples a STANDING, preset-scoped
 * composition. The tool row is therefore mounted once into a scope every Agent
 * binds to (`bindScopeParent`), never per Agent — the official shipped preset
 * declarations compose it that way, and a per-Agent mount registered after the
 * Agent's own `agent/created` can never sample. */
type ModelRoute = { provider: string; model: string }

let presetCounter = 0

/** Mount the tool row once into one fresh standing preset scope. */
async function mountPreset(ctx: Context): Promise<PresetScope> {
  presetCounter += 1
  const preset = createScope(ctx, { preset: `model-selection-${presetCounter}` })
  await preset.ctx.plugin(tool, {
    provider: 'spawn',
    modelSelectionSettings: true,
  })
  return preset
}

/** Create one Agent joined to the given standing preset scope. */
async function createAgent(ctx: Context, preset: PresetScope, id: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: (agentCtx) => {
      bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!)
    },
  })
  return handle.agent
}

async function boot(enabled = false, allowedModels: readonly ModelRoute[] = []): Promise<{ ctx: Context; create(id: string): Promise<Agent>; remount(next: { enabled: boolean; allowedModels?: readonly ModelRoute[] }): Promise<void> }> {
  const ctx = new Context()
  let selectionFiber: SubagentModelSelectionFiber | undefined
  selectionFiber = await ctx.plugin(SubagentModelSelectionConfig, { enabled, allowedModels: [...allowedModels] })
  // 0.2.1-rc.2's SubagentRuntime injects the official `workingDirectory` owner, so the
  // Agent/subagent fixture mounts it through the testkit's own option (the same
  // real directory owner the official base layer provides).
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  let preset = await mountPreset(ctx)
  return {
    ctx,
    create: (id) => createAgent(ctx, preset, id),
    remount: async (next) => {
      // A live settings edit reaches the standing tool through a NEW service
      // instance, so the standing composition is re-mounted from it. Agents
      // already composed keep the tool their own scope installed.
      await preset.dispose()
      await selectionFiber?.dispose()
      selectionFiber = await ctx.plugin(SubagentModelSelectionConfig, {
        enabled: next.enabled,
        allowedModels: [...(next.allowedModels ?? [])],
      })
      preset = await mountPreset(ctx)
    },
  }
}

/** A minimal LLM adapter advertising alpha/fast + alpha/plain. */
class CatalogAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: `${provider.toUpperCase()} API` }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider, id: 'fast', name: 'Fast', description: 'Focused work.' },
      { provider, id: 'plain', name: 'Plain' },
    ])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model === 'plain' ? 'Plain' : 'Fast',
      ...model === 'plain' ? {} : { description: 'Focused work.' },
    })
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* () { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } })()
  }
}

let callCounter = 0

/** Execute one tool through the real ToolRuntime pipeline. */
function callTool(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`composition-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

/** The tool result's text content. */
function text(result: { content?: readonly { type?: string; text?: string }[] }): string {
  return (result.content ?? []).map(block => block.text ?? '').join('')
}

test('the official subagent model-selection closed loop: fresh sessions sample the setting, old sessions keep their policy', async () => {
  const host = await boot()
  const { ctx, remount } = host
  try {
    // 1. Default-off: a composed Session's subagent tool has NO route
    //    fields and NO list_subagent_models.
    const disabled = await host.create('disabled')
    assert.equal(selectable(ctx, disabled), false,
      'default-off must not expose provider/model/reasoning_effort or list_subagent_models')
    // The negative control is only meaningful if the standing composition DID
    // install the tool: the route fields are absent, not the whole definition.
    assert.ok(ctx.tools.schemas(disabled).some(candidate => candidate.name === 'subagent'),
      'the standing preset composition must register the subagent tool when selection is off')

    // 2. Enable + allowlist: a NEW Session samples the setting and its
    //    subagent tool gains the route fields + list_subagent_models.
    await remount({ enabled: true, allowedModels: ALLOWED_MODELS })
    const enabled = await host.create('enabled')
    assert.equal(selectable(ctx, enabled), true,
      'a fresh Session composed after enabling must expose the route fields and list_subagent_models')
    // The already-composed Session is NOT rewritten by the settings change.
    assert.equal(selectable(ctx, disabled), false,
      'an already-composed Session must not be hot-changed by the settings update')

    // 3. list_subagent_models enforces the Session allowlist: an
    //    out-of-allowlist model is refused, the allowed model is served.
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const denied = await callTool(ctx, 'list_subagent_models', { provider: 'alpha', model: 'plain' }, enabled)
    assert.equal(denied.isError, true, 'an out-of-allowlist model must be refused')
    assert.match(text(denied), /is not allowed for this Session/u)
    const served = await callTool(ctx, 'list_subagent_models', { provider: 'alpha', model: 'fast' }, enabled)
    assert.equal(served.isError, false, 'an allowlisted model must be served')
    assert.match(text(served), /alpha\/fast/u)

    // 4. Disable again: a NEW Session is not selectable, while the
    //    previously-enabled Session KEEPS its durable sampled policy.
    await remount({ enabled: false })
    const disabledAgain = await host.create('disabled-again')
    assert.equal(selectable(ctx, disabledAgain), false,
      'a fresh Session composed after disabling must not expose the route fields')
    assert.equal(selectable(ctx, enabled), true,
      'a Session that sampled the policy keeps it (durable per-session policy)')
  } finally {
    await ctx.fiber.dispose()
  }
})
