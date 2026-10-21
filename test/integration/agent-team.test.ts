/**
 * S4-D2 B01 — Agent Teams against the effective preset tool scopes over the
 * real rc.2 Optional bundle patch (implementation plan §5 D2-3).
 *
 * REAL: the official `@deepseek-ai/dsh-experimental-agent-team` service, its
 * real journal/projection/roster, the real `tool-agent-team` scoped tool set,
 * the real `subagent-spawn-in-process` child provider and the four generated
 * official preset declarations. A scripted LLM answers only the teammate turns
 * (the Lead calls the real tools directly through the real ToolRuntime).
 * @module @xmoon76/dsh-pi-tui/agent-team.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  skippedInstallationReason,
  startS4D2Host,
  type S4D2BundleId,
} from '../support/optional-bundle-fixture.ts'

const B01 = '@deepseek-ai/dsh-experimental-agent-team-profile' satisfies S4D2BundleId
const skip = skippedInstallationReason([B01])
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

/** Answers the teammate prompts by content; the Lead never reaches the LLM. */
class TeammateAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  hold: Promise<void> | undefined
  releaseHold: (() => void) | undefined
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push(options)
    const text = JSON.stringify(options.messages)
    if (text.includes('HOLD_CHILD')) {
      if (this.hold !== undefined) await this.hold
      yield* textChunks('HELD_DONE')
      return
    }
    if (text.includes('SCOUT_JOB')) {
      yield* textChunks('SCOUT_DONE')
      return
    }
    yield* textChunks('TEAM_READY')
  }
}

function toolCall(ctx: { tools: { execute(input: unknown): Promise<unknown> } }, name: string, agent: unknown, args: unknown): Promise<{
  isError?: boolean
  content?: readonly { type?: string; text?: string }[]
  error?: { info?: { code?: string } }
}> {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`s4-d2-team-${++callCounter}`),
    name,
    arguments: args,
    agent,
  }) as never
}

function resultText(result: { content?: readonly { type?: string; text?: string }[] }): string {
  return (result.content ?? []).map(block => block.type === 'text' ? block.text ?? '' : '').join('')
}

test('Agent Teams: real patch scopes, four preset rosters and one Lead→teammate loop', { skip }, async t => {
  // B01-OFF baseline: the same four official presets without the Team bundle.
  // The real addition is then exactly the Team tool family, not a global claim.
  const baseline = await startS4D2Host(t, { bundles: [], presets: true })
  const baselinePresets = baseline.ctx.get('agentPresets') as { select(agent: unknown, preset: string): Promise<unknown> }
  const baselineRosters = new Map<string, readonly string[]>()
  for (const preset of ['standard', 'ptc', 'minimal', 'cordis']) {
    const agent = await baseline.createAgent(SessionId(`s4-d2-b01-base-${preset}`), {
      provider: 'scripted',
      model: 'review-model',
      cwd: join(baseline.root, 'work'),
    })
    await baselinePresets.select(agent, preset)
    baselineRosters.set(preset, baseline.toolNames(agent))
  }
  await baseline.dispose()

  const host = await startS4D2Host(t, { bundles: [B01], presets: true })
  const adapter = new TeammateAdapter()
  host.ctx.llm.registerAdapter(['scripted'], adapter)
  const presets = host.ctx.get('agentPresets') as { select(agent: unknown, preset: string): Promise<unknown> }
  const lead = await host.createAgent(SessionId('s4-d2-b01-lead'), {
    provider: 'scripted',
    model: 'review-model',
    cwd: join(host.root, 'work'),
  })

  // The B01 patch disables the four GLOBAL delegation rows. The TUI overlay
  // disables the same base rows; either way the global view must not carry
  // them while a preset-local copy may legitimately stay in an Agent scope.
  for (const name of ['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork']) {
    assert.equal(host.ctx.tools.get(name, undefined), undefined, `the global ${name} row is disabled`)
  }
  assert.equal(host.ctx.tools.get('spawn_teammate', undefined), undefined,
    'Team tools are Agent-scoped, never global')

  // Four REAL preset rosters. The preset-local delegation rows stay visible in
  // each capable preset even though the global rows are disabled (negative
  // control: never use a global has() to claim every same-name tool vanished).
  const rosters = new Map<string, readonly string[]>()
  for (const [index, preset] of ['standard', 'ptc', 'minimal', 'cordis'].entries()) {
    const agent = index === 0 ? lead : await host.createAgent(SessionId(`s4-d2-b01-${preset}`), {
      provider: 'scripted',
      model: 'review-model',
      cwd: join(host.root, 'work'),
    })
    await presets.select(agent, preset)
    const roster = host.toolNames(agent)
    rosters.set(preset, roster)
    assert.ok(roster.includes('spawn_teammate'), `${preset}: the Team tools are installed in the Lead scope`)
    assert.ok(roster.includes('team_task_create'), `${preset}: the shared task board is reachable`)
    if (preset !== 'minimal') {
      assert.ok(host.ctx.tools.get('subagent', agent) !== undefined,
        `${preset}: the preset-local subagent row is retained in the Agent scope`)
      assert.ok(host.ctx.tools.get('list_agents', agent) !== undefined,
        `${preset}: the preset-local list_agents row is retained in the Agent scope`)
    } else {
      assert.equal(host.ctx.tools.get('subagent', agent), undefined,
        'minimal never gains a delegation tool it does not declare')
      assert.equal(host.ctx.tools.get('subagent_fork', agent), undefined,
        'minimal never gains a fork delegation tool it does not declare')
      // `list_agents` remains because the TEAM owns that name in every member
      // scope; its presence is not the preset-local delegation row returning.
      assert.ok(host.ctx.tools.get('list_agents', agent) !== undefined)
    }
  }
  // Compare each roster against the B01-off baseline: every baseline tool
  // remains visible, and the Team-only family is exactly the addition.
  const TEAM_ONLY = ['spawn_teammate', 'wait_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']
  for (const preset of ['standard', 'ptc', 'minimal', 'cordis']) {
    const baselineRoster = new Set(baselineRosters.get(preset))
    const withTeam = new Set(rosters.get(preset))
    for (const tool of TEAM_ONLY) {
      assert.equal(baselineRoster.has(tool), false, `${preset}: ${tool} must not exist without B01`)
      assert.equal(withTeam.has(tool), true, `${preset}: ${tool} is the real B01 addition`)
    }
    for (const tool of baselineRoster) {
      assert.equal(withTeam.has(tool), true, `${preset}: B01 must not remove the preset-local tool ${tool}`)
    }
  }
  // The Team tools are the real addition: each capable preset keeps its own
  // declared roster and gains exactly the Team tool family.
  const teamTools = rosters.get('standard')!.filter(name =>
    ['spawn_teammate', 'send_message', 'list_agents', 'interrupt_agent', 'wait_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'].includes(name))
  assert.deepEqual([...teamTools].sort(), [
    'interrupt_agent', 'list_agents', 'send_message', 'spawn_teammate',
    'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'wait_agent',
  ].sort())

  // REAL Lead → teammate: spawn through the official tool, wait for the child's
  // real activation result, then address it by its durable name.
  const spawned = await toolCall(host.ctx as never, 'spawn_teammate', lead, {
    name: 'scout',
    description: 'Read-only scout teammate',
    prompt: 'Reply with TEAM_READY and nothing else.',
    context: 'fresh',
  })
  assert.notEqual(spawned.isError, true, resultText(spawned))
  const member = (JSON.parse(resultText(spawned)) as { member: { target: string; role: string; status: string } }).member
  assert.equal(member.target, 'scout')
  assert.equal(member.role, 'teammate')
  const team = host.ctx.get('agentTeams') as {
    listMembers(agent: unknown): Array<{ id: string; name: string; role: string; status: string }>
  }
  const roster = team.listMembers(lead)
  const scout = roster.find(candidate => candidate.name === 'scout')
  assert.ok(scout !== undefined, 'the Team roster carries the durable teammate identity')
  // The Lead's durable Activity stream carries the child identity and its real
  // settlement; the child Agent may already be retired by the provider.
  const leadEvents = (): string => JSON.stringify((lead.session.snapshotEvents() as readonly unknown[]))
  // The spawn tool returns after the child accepted its activation prompt; the
  // activation settles independently, so wait for the real member status.
  await waitFor(() => team.listMembers(lead).find(candidate => candidate.name === 'scout')?.status === 'inactive')
  const liveChild = host.ctx.agents.get(scout.id as never)
  if (liveChild !== undefined) {
    assert.equal(liveChild.session.header.parentSession, lead.session.id, 'the teammate is a real child of the Lead Session')
  }

  // list_agents is a REAL tool result, not a global catalog truth.
  const listed = await toolCall(host.ctx as never, 'list_agents', lead, {})
  assert.match(resultText(listed), /scout/)
  assert.match(resultText(listed), /lead/)

  // Shared task board: create, reassign to the live teammate, read back.
  const created = await toolCall(host.ctx as never, 'team_task_create', lead, {
    subject: 'Scout one file',
    description: 'Read one file and report its content.',
  })
  const task = JSON.parse(resultText(created)) as { id: string; revision: number }
  const assigned = await toolCall(host.ctx as never, 'team_task_update', lead, {
    task_id: task.id,
    expected_revision: task.revision,
    action: 'reassign',
    owner: 'scout',
  })
  assert.match(resultText(assigned), /scout/)
  const listedTasks = await toolCall(host.ctx as never, 'team_task_list', lead, {})
  assert.match(resultText(listedTasks), /Scout one file/)
  const readTask = await toolCall(host.ctx as never, 'team_task_get', lead, { task_id: task.id })
  assert.match(resultText(readTask), /Scout one file/)

  // A message is only an ACCEPTANCE: sent:true never proves the member ran it.
  const sent = await toolCall(host.ctx as never, 'send_message', lead, {
    target: 'scout',
    message: 'SCOUT_JOB: reply with SCOUT_DONE',
  })
  assert.notEqual(sent.isError, true, resultText(sent))
  assert.deepEqual(JSON.parse(resultText(sent)), { sent: true })
  // The Host `wait_agent` tool is the real wait surface (not only a test poll).
  const waited = await toolCall(host.ctx as never, 'wait_agent', lead, { timeout_ms: 10_000 })
  assert.notEqual(waited.isError, true, resultText(waited))
  assert.match(resultText(waited), /"timedOut"/u)
  // The addressed turn really reached the member model transport and the Lead
  // received the member's durable settlement, not just the inbox acceptance.
  await waitFor(() => leadEvents().includes('SCOUT_DONE'))
  assert.ok(adapter.requests.some(request => JSON.stringify(request.messages).includes('SCOUT_JOB')),
    'the addressed turn reached the child model transport')

  // NEGATIVE: an unknown target is refused by the official Team authority.
  const unknown = await toolCall(host.ctx as never, 'send_message', lead, { target: 'ghost', message: 'hi' })
  assert.equal(unknown.isError, true, 'an unknown Team target is refused')

  // NEGATIVE: a target that belongs to ANOTHER Team is not addressable from
  // this Lead's Team (cross-Team authorization is scoped by the roster).
  const otherLead = await host.createAgent(SessionId('s4-d2-b01-lead-other'), {
    provider: 'scripted',
    model: 'review-model',
    cwd: join(host.root, 'work'),
  })
  const outsiderSpawn = await toolCall(host.ctx as never, 'spawn_teammate', otherLead, {
    name: 'outsider',
    description: 'other team member',
    prompt: 'Reply with TEAM_READY and nothing else.',
    context: 'fresh',
  })
  assert.notEqual(outsiderSpawn.isError, true, resultText(outsiderSpawn))
  const crossTeam = await toolCall(host.ctx as never, 'send_message', lead, { target: 'outsider', message: 'hi' })
  assert.equal(crossTeam.isError, true, 'a member of another Team is not an addressable target')
  assert.match(JSON.stringify(crossTeam.error ?? {}), /TEAM_INVALID_TARGET|TEAM_MEMBER_NOT_FOUND|unknown|not an active/i)
  // NEGATIVE: a LIVE teammate cannot spawn another teammate. Hold its
  // activation model stream so the exact child Agent stays live and the real
  // Team authorization path (not a disposed identity) is exercised.
  adapter.hold = new Promise<void>(resolve => { adapter.releaseHold = resolve })
  const probeSpawn = await toolCall(host.ctx as never, 'spawn_teammate', lead, {
    name: 'probe',
    description: 'authorization probe',
    prompt: 'HOLD_CHILD',
    context: 'fresh',
  })
  assert.notEqual(probeSpawn.isError, true, resultText(probeSpawn))
  const probe = team.listMembers(lead).find(candidate => candidate.name === 'probe')
  assert.ok(probe !== undefined)
  await waitFor(() => host.ctx.agents.get(probe.id as never) !== undefined)
  const probeAgent = host.ctx.agents.get(probe.id as never)
  assert.ok(probeAgent !== undefined)
  const nested = await toolCall(host.ctx as never, 'spawn_teammate', probeAgent, {
    name: 'nested',
    description: 'not allowed',
    prompt: 'noop',
    context: 'fresh',
  })
  assert.equal(nested.isError, true, 'only the Team Lead may create teammates')
  assert.match(JSON.stringify(nested.error ?? {}), /TEAM_LEAD_REQUIRED/)
  adapter.releaseHold?.()
  await waitFor(() => team.listMembers(lead).find(candidate => candidate.name === 'probe')?.status === 'inactive')

  // TEARDOWN: a fresh Host composition has no orphan child/job from the Team.
  assert.ok(host.ctx.agents.list().length >= 2, 'the Team children are live before teardown')
  const restarted = await host.restart()
  assert.equal(restarted.ctx.agents.list().length, 0, 'Host teardown drains every Team child')
  assert.ok(restarted.activeBundles.includes(B01), 'the restarted composition still carries B01')

  // The 14 identities remain the frozen set.
})

/** Poll one in-process condition with a bounded number of event-loop turns. */
async function waitFor(condition: () => boolean, turns = 2000): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (condition()) return
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not settle')
}
