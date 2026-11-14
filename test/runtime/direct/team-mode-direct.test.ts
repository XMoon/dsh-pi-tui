/**
 * The Direct `TeamModePort` (FR1): the real official Host authority over the
 * `agentTeam`/`modelSelection` projections and the Root-only
 * `agentTeams.setEnabled` write, plus the structural settlement classification.
 *
 * The real-Host half follows `test/integration/agent-team.test.ts`: `dsh-base`
 * is booted from the provisioned official installation, the Lead runs a real
 * model request through a scripted adapter, and the port is constructed with
 * the runner-style exact live-Agent resolver.
 *
 * @module @xmoon76/dsh-pi-tui/team-mode-direct.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { DirectTeamModePort, type DirectTeamModeContextLike } from '../../../src/runtime/direct/team-mode-direct.ts'
import { cancellationError } from '../../../src/runtime/process/tasks.ts'
import { skippedInstallationReason, startOptionalBundleHost } from '../../support/optional-bundle-fixture.ts'

const skip = skippedInstallationReason([])
const signal = new AbortController().signal
let callCounter = 0

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push(options)
    yield* textChunks('TEAM_READY')
  }
}

async function spawnChild(ctx: Context, lead: Agent): Promise<Agent> {
  const tools = ctx.tools as unknown as {
    resolve(context: {
      readonly agent: Agent
      readonly modelSelection: { readonly provider: string; readonly model: string }
      readonly signal: AbortSignal
    }): Promise<{ dispose(): void }>
  }
  const toolSet = await tools.resolve({
    agent: lead,
    modelSelection: { provider: 'scripted', model: 'review-model' },
    signal,
  })
  try {
    const result = await executeModelToolFixture(ctx, {
      signal,
      callId: ToolCallId(`team-mode-direct-${++callCounter}`),
      name: 'subagent',
      arguments: { name: 'direct-scout', description: 'Direct Team child', prompt: 'Reply TEAM_READY.' },
      agent: lead,
      toolSet: toolSet as never,
    }) as { isError?: boolean }
    assert.notEqual(result.isError, true)
  } finally {
    toolSet.dispose()
  }
  const subagents = ctx.get('subagents') as {
    resolveName(caller: Agent, name: string, signal: AbortSignal): Promise<SessionId>
  }
  const childId = await subagents.resolveName(lead, 'direct-scout', signal)
  const child = ctx.agents.get(childId)
  assert.ok(child !== undefined)
  return child
}

test('FR1 Direct Team port: real Host projection, Root write and modeled history', { skip }, async t => {
  const host = await startOptionalBundleHost(t, { bundles: [], presets: true })
  const adapter = new ScriptedAdapter()
  host.ctx.llm.registerAdapter(['scripted'], adapter)
  const presets = host.ctx.get('agentPresets') as { select(agent: unknown, preset: string): Promise<unknown> }
  const lead = await host.createAgent(SessionId('fr1-direct-lead'), {
    provider: 'scripted',
    model: 'review-model',
    cwd: join(host.root, 'work'),
  })
  await presets.select(lead, 'standard')
  const port = new DirectTeamModePort(host.ctx as DirectTeamModeContextLike, (sessionId) => {
    const agent = host.ctx.agents.get(SessionId(sessionId))
    return agent === undefined ? undefined : agent
  })

  // Default OFF, no model request yet.
  assert.deepEqual(port.read('fr1-direct-lead'), {
    kind: 'ready',
    enabled: false,
    modelRequestHistory: 'none',
  })

  // Root-only official write: committed, one durable team/mode, projection On.
  const enables: string[] = []
  const offChanged = host.ctx.get('sessionProjections') as {
    onChanged(listener: (session: unknown, key: string) => void): () => void
  }
  const unsubscribe = offChanged.onChanged((session, key) => {
    if (Object.is(session, lead.session)) enables.push(key)
  })
  assert.deepEqual(await port.setEnabled('fr1-direct-lead', true, signal), { kind: 'committed' })
  unsubscribe()
  assert.ok(enables.includes('agentTeam'), 'the projection change feed named agentTeam')
  assert.deepEqual(port.read('fr1-direct-lead'), {
    kind: 'ready',
    enabled: true,
    modelRequestHistory: 'none',
  })
  const modeEvents = host.events(lead).filter((event) => (event as { type?: string }).type === 'team/mode')
  assert.equal(modeEvents.length, 1, 'the official service appended exactly one team/mode record')

  // A real model request (never `selectModel`) records the confirmation history.
  lead.followup(createUserMessage({ content: [{ type: 'text', text: 'FR1 real request' }], source: { kind: 'user' } }))
  await lead.whenIdle()
  assert.ok(adapter.requests.length > 0)
  assert.deepEqual(port.read('fr1-direct-lead'), {
    kind: 'ready',
    enabled: true,
    modelRequestHistory: 'recorded',
  })

  // A child Session inherits the mode through the service but may not write or
  // read a Team state of its own through this port.
  const child = await spawnChild(host.ctx, lead)
  assert.deepEqual(port.read(child.id), {
    kind: 'unavailable',
    reason: 'Agent Team mode is available only for the root Session',
  })
  assert.deepEqual(await port.setEnabled(child.id, false, signal), {
    kind: 'rejected',
    reason: 'Agent Team mode can only be changed from the root Session',
  })
  assert.equal((host.ctx.get('agentTeams') as { isEnabled(agent: Agent): boolean }).isEnabled(child), true,
    'the child still inherits the root selection')

  // Disable → committed → OFF; the child read stays root-only.
  assert.deepEqual(await port.setEnabled('fr1-direct-lead', false, signal), { kind: 'committed' })
  assert.deepEqual(port.read('fr1-direct-lead'), {
    kind: 'ready',
    enabled: false,
    modelRequestHistory: 'recorded',
  })

  // Subscription: only the exact Session and only the two Team keys notify.
  let notifications = 0
  const dispose = port.subscribe('fr1-direct-lead', () => { notifications += 1 })
  const other = await host.createAgent(SessionId('fr1-direct-other'), {
    provider: 'scripted',
    model: 'review-model',
    cwd: join(host.root, 'work'),
  })
  await presets.select(other, 'standard')
  await (host.ctx.get('agentTeams') as {
    setEnabled(agent: Agent, enabled: boolean): Promise<void>
  }).setEnabled(other, true)
  assert.equal(notifications, 0, 'another Session projection change is not this subscription')
  await (host.ctx.get('agentTeams') as {
    setEnabled(agent: Agent, enabled: boolean): Promise<void>
  }).setEnabled(lead, true)
  assert.equal(notifications, 1, 'the exact Session team/mode change notifies once')
  dispose()
  dispose()
  await (host.ctx.get('agentTeams') as {
    setEnabled(agent: Agent, enabled: boolean): Promise<void>
  }).setEnabled(lead, false)
  assert.equal(notifications, 1, 'the disposer stops notifications and is idempotent')
})

test('FR1 Direct Team port: a post-append flush AbortError is indeterminate, not cancelled', { skip }, async t => {
  const host = await startOptionalBundleHost(t, { bundles: [], presets: true })
  host.ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
  const presets = host.ctx.get('agentPresets') as { select(agent: unknown, preset: string): Promise<unknown> }
  const lead = await host.createAgent(SessionId('fr1-direct-flush-abort'), {
    provider: 'scripted',
    model: 'review-model',
    cwd: join(host.root, 'work'),
  })
  await presets.select(lead, 'standard')
  const port = new DirectTeamModePort(host.ctx as DirectTeamModeContextLike, (sessionId) => {
    const agent = host.ctx.agents.get(SessionId(sessionId))
    return agent === undefined ? undefined : agent
  })
  // A REAL session/flush listener that fails with a cancellation-shaped value
  // AFTER the official service appended team/mode.
  const unsubscribe = host.ctx.on('session/flush', (() => { throw cancellationError('flush listener aborted') }) as never)
  let outcome
  try {
    outcome = await port.setEnabled('fr1-direct-flush-abort', true, signal)
  } finally {
    unsubscribe()
  }
  assert.equal(outcome.kind, 'indeterminate',
    'an AbortError-shaped flush failure after the append must NOT be reported as a pre-dispatch cancellation')
  // The write really was appended and the in-memory projection is ON; only the
  // durability result is unconfirmed.
  const modeEvents = host.events(lead).filter((event) => (event as { type?: string }).type === 'team/mode')
  assert.equal(modeEvents.length, 1, 'the official service appended exactly one team/mode before the flush failed')
  assert.equal((host.ctx.get('agentTeams') as { isEnabled(agent: Agent): boolean }).isEnabled(lead), true,
    'the in-memory Team mode changed even though the flush failed')
})

test('FR1 Direct Team port: durable OFF survives restart and resume', { skip }, async t => {
  const host = await startOptionalBundleHost(t, { bundles: [], presets: true })
  host.ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
  const presets = host.ctx.get('agentPresets') as { select(agent: unknown, preset: string): Promise<unknown> }
  const lead = await host.createAgent(SessionId('fr1-direct-restart-lead'), {
    provider: 'scripted',
    model: 'review-model',
    cwd: join(host.root, 'work'),
  })
  await presets.select(lead, 'standard')
  const port = new DirectTeamModePort(host.ctx as DirectTeamModeContextLike, (sessionId) => {
    const agent = host.ctx.agents.get(SessionId(sessionId))
    return agent === undefined ? undefined : agent
  })
  assert.deepEqual(await port.setEnabled('fr1-direct-restart-lead', true, signal), { kind: 'committed' })
  assert.deepEqual(await port.setEnabled('fr1-direct-restart-lead', false, signal), { kind: 'committed' })

  const restarted = await host.restart()
  const resumed = await (restarted.ctx.agents as unknown as {
    resume(options: { resumeSessionId: SessionId; agentOptions?: { provider?: string; model?: string }; setup?: () => void }):
      Promise<{ agent: Agent; dispose(): Promise<void> }>
  }).resume({
    resumeSessionId: SessionId('fr1-direct-restart-lead'),
    agentOptions: { provider: 'scripted', model: 'review-model' },
    setup: () => {},
  })
  try {
    const restartedPort = new DirectTeamModePort(restarted.ctx as DirectTeamModeContextLike, (sessionId) => {
      const agent = restarted.ctx.agents.get(SessionId(sessionId))
      return agent === undefined ? undefined : agent
    })
    assert.deepEqual(restartedPort.read('fr1-direct-restart-lead'), {
      kind: 'ready',
      enabled: false,
      modelRequestHistory: 'none',
    }, 'the saved OFF state and the no-request history survive the restart')
  } finally {
    await resumed.dispose()
  }
})

test('FR1 Direct Team port: settlement classification fails closed', () => {
  const projections = {
    snapshot: () => ({ values: { agentTeam: { enabled: false }, modelSelection: { lastUsed: null } } }),
    onChanged: () => () => {},
  }
  const agent = { session: {} }
  const root = {
    rootOf: (candidate: unknown) => candidate,
  }
  const create = (service: unknown, signalOverride?: AbortSignal): DirectTeamModePort => {
    const ctx = {
      get: (name: string) => name === 'sessionProjections' ? projections : name === 'subagents' ? root : service,
    }
    return new DirectTeamModePort(ctx, () => agent)
  }

  // A flush/observation failure after the official Root admission is an
  // indeterminate write, never a refusal.
  const failing = create({ setEnabled: async () => { throw new Error('flush failed') } })
  return failing.setEnabled('s1', true, signalOverride() ?? signal).then((outcome) => {
    assert.equal(outcome.kind, 'indeterminate')
    assert.match(outcome.reason, /flush failed/u)

    // An aborted signal never dispatches.
    const controller = new AbortController()
    controller.abort()
    return create({ setEnabled: async () => { throw new Error('must not run') } })
      .setEnabled('s1', true, controller.signal)
  }).then((outcome) => {
    assert.deepEqual(outcome, { kind: 'cancelled', reason: 'the Team mode change was cancelled' })

    // The official Root-only code is a proven refusal.
    const leadRequired = Object.assign(new Error('change Team mode from the root Session'), { code: 'TEAM_LEAD_REQUIRED' })
    return create({ setEnabled: async () => { throw leadRequired } }).setEnabled('s1', true, signal)
  }).then((outcome) => {
    assert.equal(outcome.kind, 'rejected')
    assert.match(outcome.reason, /root Session/u)
  })
})

/** A helper so the first classification case can share one signal instance. */
function signalOverride(): AbortSignal {
  return signal
}
