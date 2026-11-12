/**
 * rc.2 base Agent Teams over the real DSH composition.
 *
 * REAL: the `dsh-base` `agent-team` service (journal/projection/task board) and
 * its `tool-agent-team` task tools, the real preset mirrors, the real
 * `subagent` tool + in-process spawn provider, and the real ToolRuntime. The
 * retired rc.1 `experimental-agent-team-profile` bundle is NOT mounted: rc.2
 * promotes Team to the base layer and creates teammates through `subagent`
 * with a `name`.
 *
 * @module @xmoon76/dsh-pi-tui/agent-team.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  skippedInstallationReason,
  startOptionalBundleHost,
} from '../support/optional-bundle-fixture.ts'

const skip = skippedInstallationReason([])
const signal = new AbortController().signal
let callCounter = 0

/** The rc.2 Team task tools are conditionally available per root Team mode. */
const TEAM_TASK_TOOLS = ['team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'] as const

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Answers the child prompts by content; the Lead never reaches the LLM. */
class TeammateAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push(options)
    const text = JSON.stringify(options.messages)
    if (text.includes('SCOUT_JOB')) {
      yield* textChunks('SCOUT_DONE')
      return
    }
    yield* textChunks('TEAM_READY')
  }
}

/** One model call through the REAL step admission (the same ResolvedToolSet
 *  the agent loop prepares for a model request). This is what makes the
 *  conditional Team tools prove their actual presence/absence, not just the
 *  registered definition list. */
async function toolCall(ctx: Context, name: string, agent: Agent, args: unknown): Promise<{
  isError?: boolean
  content?: readonly { type?: string; text?: string }[]
  error?: { info?: { code?: string } }
}> {
  const tools = ctx.tools as unknown as {
    resolve(context: {
      readonly agent: Agent
      readonly modelSelection: { readonly provider: string; readonly model: string }
      readonly signal: AbortSignal
    }): Promise<{ dispose(): void }>
  }
  const toolSet = await tools.resolve({
    agent,
    modelSelection: { provider: 'scripted', model: 'review-model' },
    signal,
  })
  try {
    return await executeModelToolFixture(ctx, {
      signal,
      callId: ToolCallId(`rc2-base-team-${++callCounter}`),
      name,
      arguments: args,
      agent,
      toolSet: toolSet as never,
    })
  } finally {
    toolSet.dispose()
  }
}

function resultText(result: { content?: readonly { type?: string; text?: string }[] }): string {
  return (result.content ?? []).map(block => block.type === 'text' ? block.text ?? '' : '').join('')
}

function errorText(result: { error?: { info?: { code?: string } } }): string {
  return JSON.stringify(result.error ?? {})
}

test('rc.2 base Agent Teams: default OFF, root enablement, shared board and named subagent', { skip }, async t => {
  const host = await startOptionalBundleHost(t, { bundles: [], presets: true })
  const adapter = new TeammateAdapter()
  host.ctx.llm.registerAdapter(['scripted'], adapter)
  const presets = host.ctx.get('agentPresets') as { select(agent: unknown, preset: string): Promise<unknown> }
    const team = host.ctx.get('agentTeams') as {
    isEnabled(agent: Agent): boolean
    setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void>
  }
  const subagents = host.ctx.get('subagents') as {
    resolveName(caller: Agent, name: string, signal: AbortSignal): Promise<SessionId>
  }

  const lead = await host.createAgent(SessionId('rc2-base-team-lead'), {
    provider: 'scripted',
    model: 'review-model',
    cwd: join(host.root, 'work'),
  })
  await presets.select(lead, 'standard')

  // ── default OFF: the base service mounts, but no Team tool is discoverable
  // in the REAL step-owned tool selection and the task authority itself refuses
  assert.equal(team.isEnabled(lead), false, 'Team mode is OFF by default')
  assert.equal(host.hasTool('spawn_teammate', lead), false, 'rc.2 retired the spawn_teammate tool')
  assert.equal(host.hasTool('subagent', lead), true, 'teammates are created through the standard subagent tool')
  const disabledCreate = await toolCall(host.ctx, 'team_task_create', lead, {
    subject: 'must not exist',
    description: 'the disabled Team authority must refuse creation',
  })
  assert.equal(disabledCreate.isError, true, 'a disabled Team session cannot create a task')
  assert.match(errorText(disabledCreate), /UNKNOWN_TOOL/u,
    'the conditional Team tool is not admitted to the model executor while Team mode is off')

  // ── root enablement: the official service appends the durable team/mode and
  // the conditional tools become discoverable in the SAME agent scope ─────────
  await team.setEnabled(lead, true)
  assert.equal(team.isEnabled(lead), true)
  assert.ok((host.events(lead) as readonly { type?: string }[]).some(event => event.type === 'team/mode'),
    'enablement is persisted as the official team/mode record')

  // ── the real shared board: create → list → get ──────────────────────────────
  const created = await toolCall(host.ctx, 'team_task_create', lead, {
    subject: 'Scout one file',
    description: 'Read one file and report its content.',
  })
  assert.notEqual(created.isError, true, resultText(created))
  const task = JSON.parse(resultText(created)) as {
    id: string
    revision: number
    subject: string
    status: string
    ready: boolean
    owner?: string
  }
  assert.equal(task.subject, 'Scout one file')
  assert.equal(task.status, 'pending')
  assert.equal(task.revision, 1)
  assert.equal(task.owner, undefined, 'a new task starts unowned')

  const listed = await toolCall(host.ctx, 'team_task_list', lead, {})
  assert.notEqual(listed.isError, true, resultText(listed))
  const page = JSON.parse(resultText(listed)) as { tasks: Array<{ id: string; subject: string }> }
  assert.deepEqual(page.tasks.map(row => row.id), [task.id])
  const read = await toolCall(host.ctx, 'team_task_get', lead, { task_id: task.id })
  assert.notEqual(read.isError, true, resultText(read))
  assert.equal((JSON.parse(resultText(read)) as { revision: number }).revision, 1)

  // ── teammate creation is the standard subagent tool with a unique name ─────
  const spawned = await toolCall(host.ctx, 'subagent', lead, {
    name: 'scout',
    description: 'Read-only scout teammate',
    prompt: 'Reply with TEAM_READY and nothing else.',
  })
  assert.notEqual(spawned.isError, true, resultText(spawned))
  assert.equal(resultText(spawned), 'started subagent scout',
    'the rc.2 activation result names the child instead of exposing a session id')
  const childId = await subagents.resolveName(lead, 'scout', signal)
  const child = host.ctx.agents.get(childId)
  assert.ok(child !== undefined, 'the named teammate is a live child Agent')
  // Root/child inheritance: the child reads the same tree-level Team mode.
  assert.equal(team.isEnabled(child), true, 'a child inherits the root Team selection')

  // ── root-only authority: a child cannot change the Team mode, and only the
  // root may reassign; the child may claim its own task ──────────────────────
  await assert.rejects(team.setEnabled(child, true), (error: unknown) => {
    assert.match(String((error as { code?: unknown }).code ?? error), /TEAM_LEAD_REQUIRED/u)
    return true
  }, 'only the root Session may change Team mode')
  const childReassign = await toolCall(host.ctx, 'team_task_update', child, {
    task_id: task.id,
    expected_revision: task.revision,
    action: 'reassign',
    owner: 'scout',
  })
  assert.equal(childReassign.isError, true, 'a teammate cannot reassign a shared task')
  assert.match(errorText(childReassign), /TEAM_LEAD_REQUIRED/u)
  const claimed = await toolCall(host.ctx, 'team_task_update', child, {
    task_id: task.id,
    expected_revision: task.revision,
    action: 'claim',
  })
  assert.notEqual(claimed.isError, true, resultText(claimed))
  const claimedTask = JSON.parse(resultText(claimed)) as { revision: number; owner?: string; status: string }
  assert.equal(claimedTask.owner, 'scout', 'the task names its owner by agent name, not session id')
  assert.equal(claimedTask.status, 'in_progress')
  // The root reassigns the SAME task to itself by name (ownerName authority).
  const reassigned = await toolCall(host.ctx, 'team_task_update', lead, {
    task_id: task.id,
    expected_revision: claimedTask.revision,
    action: 'reassign',
    owner: 'lead',
  })
  assert.notEqual(reassigned.isError, true, resultText(reassigned))
  assert.equal((JSON.parse(resultText(reassigned)) as { owner?: string }).owner, 'lead')

  // ── the addressed turn really reaches the child model transport, and the
  // durable child path is a real Agent/Session ───────────────────────────────
  const sent = await toolCall(host.ctx, 'send_message', lead, {
    agent: 'scout',
    message: 'SCOUT_JOB: reply with SCOUT_DONE',
  })
  assert.notEqual(sent.isError, true, resultText(sent))
  await waitFor(() => JSON.stringify(host.events(lead)).includes('SCOUT_DONE'))
  assert.ok(adapter.requests.some(request => JSON.stringify(request.messages).includes('SCOUT_JOB')),
    'the addressed turn reached the child model transport')

  // ── disabling the mode hides the tools again; the durable board survives ──
  await team.setEnabled(lead, false)
  assert.equal(team.isEnabled(lead), false)
  const disabledCreateAgain = await toolCall(host.ctx, 'team_task_create', lead, {
    subject: 'must still not exist',
    description: 'the disabled Team authority must refuse creation',
  })
  assert.equal(disabledCreateAgain.isError, true)
  assert.match(errorText(disabledCreateAgain), /UNKNOWN_TOOL/u,
    'disabling Team mode removes the tool from model admission again')

  // ── teardown: a fresh Host has no orphan child and still defaults OFF ─────
  const restarted = await host.restart()
  assert.equal(restarted.ctx.agents.list().length, 0, 'Host teardown drains every Team child')
  const restartedTeam = restarted.ctx.get('agentTeams') as { isEnabled(agent: Agent): boolean }
  const restartedLead = await restarted.createAgent(SessionId('rc2-base-team-restarted-lead'), {
    provider: 'scripted',
    model: 'review-model',
    cwd: join(restarted.root, 'work'),
  })
  assert.equal(restartedTeam.isEnabled(restartedLead), false, 'a fresh Session starts with Team OFF again')
})

/** Poll one in-process condition with a bounded number of event-loop turns. */
async function waitFor(condition: () => boolean, turns = 2000): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (condition()) return
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not settle')
}
