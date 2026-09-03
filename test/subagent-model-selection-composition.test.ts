/**
 * The official subagent model-selection CLOSED LOOP (the review's P2 gate):
 * the TUI writes the official `subagent-model-selection` section, and a NEW
 * standard-composed Session's `subagent` tool must actually expose
 * provider/model/reasoning_effort plus `list_subagent_models` — the exact
 * capability that supersedes the legacy `subagent_route` routing. The stack
 * is the REAL alpha.4 host: the settings service, the
 * subagent-model-selection-settings service, the Agent registry, the
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
import { ToolCallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as tool from '@deepseek-ai/dsh-tool-subagent'
import SubagentModelSelectionConfig, {
  SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE,
} from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'

const ALLOWED_MODELS = [{ provider: 'alpha', model: 'fast' }]

/** Writable in-memory settings provider (the upstream package harness). */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** Whether one Agent's delegation definition carries the route fields. */
function selectable(ctx: Context, agent: Agent): boolean {
  const schema = ctx.tools.schemas(agent).find(candidate => candidate.name === 'subagent')
  const properties = (schema?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  return properties?.['provider'] !== undefined
    && properties['model'] !== undefined
    && properties['reasoning_effort'] !== undefined
    && ctx.tools.schemas(agent).some(candidate => candidate.name === 'list_subagent_models')
}

/** Mount the real settings, Agent, provider, and tool services. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(SubagentModelSelectionConfig)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  return ctx
}

/** Create one Agent whose setup mounts the settings-controlled tool row. */
async function createAgent(ctx: Context, id: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx) => {
      await agentCtx.plugin(tool, {
        provider: 'spawn',
        modelSelectionSettings: true,
        backgroundMode: 'continuable',
      })
    },
  })
  return handle.agent
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
  const ctx = await boot()
  try {
    // 1. Default-off: a composed Session's subagent tool has NO route
    //    fields and NO list_subagent_models.
    const disabled = await createAgent(ctx, 'disabled')
    assert.equal(selectable(ctx, disabled), false,
      'default-off must not expose provider/model/reasoning_effort or list_subagent_models')

    // 2. Enable + allowlist: a NEW Session samples the setting and its
    //    subagent tool gains the route fields + list_subagent_models.
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const enabled = await createAgent(ctx, 'enabled')
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
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: false })
    const disabledAgain = await createAgent(ctx, 'disabled-again')
    assert.equal(selectable(ctx, disabledAgain), false,
      'a fresh Session composed after disabling must not expose the route fields')
    assert.equal(selectable(ctx, enabled), true,
      'a Session that sampled the policy keeps it (durable per-session policy)')
  } finally {
    await ctx.fiber.dispose()
  }
})
