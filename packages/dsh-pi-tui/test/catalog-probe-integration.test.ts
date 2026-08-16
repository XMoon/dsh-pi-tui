/**
 * Real-composition integration test for the catalog probe: the probe
 * lifecycle driven against the REAL agent loop, session store, command
 * registry, skill registry and LLM/tool services — not fakes. This is the
 * M0 gate's core evidence: a short-lived agent reads effective commands
 * (global + agent-scoped) and human-invocable skills, produces ZERO session
 * events, and its dispose removes the session from the live store.
 *
 * The full disk-artifact check (persistence list / file count) runs in the
 * real-profile smoke (the persistence backends are not part of this bundle's
 * dependency tree); the zero-event gate exercised here is the same check the
 * probe enforces at startup.
 * @module @xmoon76/dsh-pi-tui/catalog-probe-integration.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry, { type SkillProvider, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { probeSurfaceCatalog } from '../src/catalog-probe.ts'
import { createDiag } from '../src/diag.ts'
import { readSurfaceCatalog, type SurfaceCatalogContext } from '../src/surface-catalog.ts'

/** One real skill provider feeding the REAL registry (user-invocable +
 * model-only entries, so the official policy filter has something to cut). */
function fakeSkillProvider(entries: readonly SkillCandidate[]): SkillProvider {
  return {
    name: 'integration-test',
    list: async () => entries,
    get: async (candidate) => ({ ...candidate, content: 'skill body' }),
  }
}

/** Mount the real composition services (the upstream agent-loop testkit
 * order) plus the command and skill registries. */
async function mountRuntime(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SkillRegistry, {})
  return ctx
}

/** The probe's context surface, resolved against the real runtime. */
function surfaceContext(ctx: Context): SurfaceCatalogContext {
  return {
    get: (name) => {
      if (name === 'commands') return ctx.get('commands') as never
      if (name === 'skills') return ctx.get('skills') as never
      return ctx.get('agentPresets') as never
    },
  }
}

/** Tear down every mounted plugin fiber (the root context owns no runtime). */
async function disposeRuntime(ctx: Context): Promise<void> {
  const disposals: Promise<unknown>[] = []
  for (const runtime of [...ctx.registry.values()]) {
    for (const fiber of runtime.fibers) disposals.push(Promise.resolve(fiber.dispose()))
  }
  await Promise.allSettled(disposals)
}

test('a real short-lived probe agent reads scoped commands + human skills, stays zero-event, and disposes cleanly', async () => {
  const ctx = await mountRuntime()
  const createdIds: string[] = []
  const disposedIds: string[] = []
  ctx.on('session/created', (session: { id: string }) => { createdIds.push(session.id) })
  ctx.on('session/disposed', (session: { id: string }) => { disposedIds.push(session.id) })

  // A global command both probe and real agents see.
  ctx.commands.register({
    name: 'globalcmd',
    description: 'A global command',
    handler: () => ({ kind: 'success' }),
  })
  // A real provider: one human-invocable skill, one model-only skill.
  const entries: readonly SkillCandidate[] = [
    {
      name: 'human-skill', description: 'Human invocable', rank: 10,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled', provider: 'integration-test', locator: 'test',
    },
    {
      name: 'model-only-skill', description: 'Model only', rank: 10,
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'bundled', provider: 'integration-test', locator: 'test',
    },
  ]
  ctx.skills.registerProvider(() => fakeSkillProvider(entries))

  const selection = { current: undefined, assembled: undefined }
  const composition = {
    agentPreset: 'standard',
    setup: (agentCtx: Context): void => {
      installModelSelection(agentCtx, selection)
      // The plan-mode pattern: an agent-scoped command registered through
      // the agent context's injected commands child.
      agentCtx.inject(['commands'], (commandCtx) => {
        commandCtx.commands.register({
          name: 'scopedcmd',
          description: 'Scoped to this agent',
          handler: () => ({ kind: 'success' }),
        })
      })
    },
  }

  const snapshot = await probeSurfaceCatalog({
    agents: ctx.agents as never,
    composition,
    agentOptions: { provider: 'p', model: 'm' },
    cwd: '/ws',
    signal: new AbortController().signal,
    readCatalog: (agent, signal) => readSurfaceCatalog(agent, signal, surfaceContext(ctx)),
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  })

  // Effective commands: global + agent-scoped, with the scoped override.
  assert.deepEqual(
    snapshot.commands.map(item => item.name).sort(),
    ['globalcmd', 'scopedcmd'],
    'the probe agent must see its effective command view',
  )
  assert.deepEqual(
    snapshot.scopedCommands.map(item => item.name),
    ['scopedcmd'],
    'the agent-scoped contribution must be the derived override',
  )
  // Human skills: the official policy cut through the REAL registry.
  assert.deepEqual(
    snapshot.skills.map(item => item.name),
    ['human-skill'],
    'model-only skills must not reach the human catalog',
  )
  assert.deepEqual(snapshot.issues, [], 'no provider may report a failure')

  // Zero-event gate: the probe itself enforces it; the created/disposed
  // counters below additionally prove the live lifecycle closed cleanly.
  assert.equal(createdIds.length, 1, 'the probe must publish exactly one session')
  assert.equal(disposedIds.length, 1, 'the probe session must be disposed')
  assert.equal(createdIds[0], disposedIds[0], 'the same session id must be created and disposed')
  assert.equal(ctx.sessions.get(createdIds[0] as never), undefined, 'dispose must remove the session from the live store')

  await disposeRuntime(ctx)
})
