/**
 * M0 contract gate for the standing-scope skill catalog: the cold skill
 * read through a preset's STANDING SCOPE works against the real
 * dsh-agent-presets + dsh-skill services without creating an Agent, a
 * session, or a turn — the mechanism that avoids the catalog-probe dead
 * end (host `session/created` observers like dsh-permission-presets write
 * durable knob events into every fresh session).
 *
 * Assertions:
 * - `standingKeyFor()` returns the preset's standing `ScopeKey`; the mount
 *   creates NO session and emits NO session event;
 * - `skills.snapshot({ cwd, scope: standingKey })` returns the injected
 *   provider's summaries (invocation metadata intact);
 * - the standing mount is REUSED: a second `standingKeyFor()` returns the
 *   SAME key object, and the first real Agent created on the same preset
 *   joins that standing generation (the key object is unchanged);
 * - the real Agent's live snapshot matches the standing snapshot for the
 *   same composition.
 *
 * The fixture preset is intentionally EMPTY (rows would require services
 * outside the bundle dependency tree); shipped-preset row mounts are
 * verified in the real-profile smoke. Providers are injected directly —
 * `dsh-skill-filesystem` is not part of this bundle's dependency tree.
 * @module @xmoon76/dsh-pi-tui/skill-catalog-standing.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry, { type SkillProvider } from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

/** The fixture preset root (bundled with the tests, not shipped). */
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'presets')

/** One provider feeding the REAL registry (global layer — visible to any
 * scope along the chain, exactly like a host-layered skill row). */
function fixtureProvider(): SkillProvider {
  return {
    name: 'fixture-provider',
    list: async () => [
      {
        name: 'user-skill', description: 'User invocable', rank: 10,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled', provider: 'fixture-provider', locator: 'user-skill',
      },
      {
        name: 'model-only-skill', description: 'Model only', rank: 10,
        invocation: { modelInvocable: true, userInvocable: false },
        source: 'bundled', provider: 'fixture-provider', locator: 'model-only-skill',
      },
    ],
    get: async (candidate) => ({ ...candidate, content: 'body' }),
  }
}

/** Mount the full test runtime: loader + agent loop prerequisites + the
 * registries + the preset roster over the fixture root. */
async function mountRuntime(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.baseUrl = pathToFileURL(`${process.cwd()}/`).href
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SkillRegistry, {})
  // alpha.2 agent-presets registers its projection unit at construction and
  // requires the shared projection registry to be composed first.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentPresets, {
    default: 'fixture',
    roots: [{ path: FIXTURE_ROOT, trust: 'system' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  return ctx
}

/** Tear down every mounted plugin fiber (the root context owns no runtime). */
async function disposeRuntime(ctx: Context): Promise<void> {
  const disposals: Promise<unknown>[] = []
  for (const runtime of [...ctx.registry.values()]) {
    for (const fiber of runtime.fibers) disposals.push(Promise.resolve(fiber.dispose()))
  }
  await Promise.allSettled(disposals)
}

test('a standing-scope skill read creates no session, emits no event, and serves the injected provider catalog', async () => {
  const ctx = await mountRuntime()
  try {
    const presets = ctx.get('agentPresets')
    const skills = ctx.get('skills')
    assert.ok(presets !== undefined && typeof presets.standingKeyFor === 'function',
      'the installed agent-presets must expose standingKeyFor (M0 gate)')
    assert.ok(skills !== undefined && typeof skills.snapshot === 'function',
      'the installed dsh-skill must expose snapshot (M0 gate)')
    skills.registerProvider(fixtureProvider)

    const key = await presets.standingKeyFor('fixture')
    assert.deepEqual(key, { agentPreset: 'fixture' }, 'the standing key identifies the preset')

    // No session, no agent, no session event — the mechanism that avoids
    // the probe dead end (permission-presets writes on session/created).
    assert.equal(ctx.sessions.list().length, 0, 'no session may exist after a standing read')
    assert.equal(ctx.agents.list?.().length ?? 0, 0, 'no agent may exist after a standing read')

    const snapshot = await skills.snapshot({ cwd: '/ws', scope: key })
    const names = snapshot.skills.map(skill => skill.name)
    assert.deepEqual(names.sort(), ['model-only-skill', 'user-skill'],
      'the injected provider catalog is visible through the standing scope')
    assert.equal(snapshot.complete, true)
    const userSkill = snapshot.skills.find(skill => skill.name === 'user-skill')
    assert.equal(userSkill?.invocation.userInvocable, true, 'invocation metadata survives the snapshot')
  } finally {
    await disposeRuntime(ctx)
  }
})

test('the standing mount is reused: the same key object on re-resolution and after a real Agent joins', async () => {
  const ctx = await mountRuntime()
  try {
    const presets = ctx.get('agentPresets')
    const skills = ctx.get('skills')
    assert.ok(presets !== undefined && skills !== undefined)
    skills.registerProvider(fixtureProvider)

    const key1 = await presets.standingKeyFor('fixture')
    const key2 = await presets.standingKeyFor('fixture')
    assert.equal(key2, key1, 'a second standing resolution must reuse the same mount (same key object)')

    // A real Agent on the same preset joins the standing generation.
    const selected = { current: undefined, assembled: undefined }
    const resolvedId = (await presets.resolve('fixture')).id
    const handle = await ctx.agents.create({
      sessionId: SessionId('session-stand-1'),
      meta: { cwd: '/ws', agentPreset: resolvedId },
      agentOptions: {},
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, selected)
        // Deliberately NOT returned: the agent-loop treats a returned
        // object as an AgentSetupCommit, and mount resolves to an
        // AgentPreset (no commit()).
        await presets.mount(agentCtx, resolvedId)
      },
    })
    try {
      await handle.agent.whenIdle()
      const key3 = await presets.standingKeyFor('fixture')
      assert.equal(key3, key1, 'the real Agent must join the existing standing generation, not mount a second one')
      assert.equal(handle.agent.session.events.length, 0, 'the fixture composition stays zero-event')
    } finally {
      await handle.dispose()
    }
  } finally {
    await disposeRuntime(ctx)
  }
})

test('the real Agent view matches the standing view for the same composition', async () => {
  const ctx = await mountRuntime()
  try {
    const presets = ctx.get('agentPresets')
    const skills = ctx.get('skills')
    assert.ok(presets !== undefined && skills !== undefined)
    skills.registerProvider(fixtureProvider)

    const key = await presets.standingKeyFor('fixture')
    const standing = await skills.snapshot({ cwd: '/ws', scope: key })

    const selected = { current: undefined, assembled: undefined }
    const resolvedId = (await presets.resolve('fixture')).id
    const handle = await ctx.agents.create({
      sessionId: SessionId('session-stand-2'),
      meta: { cwd: '/ws', agentPreset: resolvedId },
      agentOptions: {},
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, selected)
        // Deliberately NOT returned: the agent-loop treats a returned
        // object as an AgentSetupCommit, and mount resolves to an
        // AgentPreset (no commit()).
        await presets.mount(agentCtx, resolvedId)
      },
    })
    try {
      await handle.agent.whenIdle()
      // The live path: the registry the agent actually sees (serviceFor
      // falls back to the host registry when the preset mounts none).
      const liveRegistry = presets.serviceFor(handle.agent, 'skills') ?? skills
      const live = await liveRegistry.snapshot({ cwd: '/ws', scope: handle.agent })
      assert.deepEqual(
        live.skills.map(skill => skill.name).sort(),
        standing.skills.map(skill => skill.name).sort(),
        'the live Agent view must match the standing view for the same composition',
      )
    } finally {
      await handle.dispose()
    }
  } finally {
    await disposeRuntime(ctx)
  }
})
