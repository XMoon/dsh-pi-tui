/**
 * The official Agent Team board reaches the mounted `/tasks` Team page.
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the installed DSH rc.3 base
 * `agent-team` service and its conditional `team_task_*` tools, the shipped
 * `standard` preset, the official profile/patch reader and `boot()` Loader,
 * the production TUI runner mounted on the SAME Context, the real
 * `/model` Team row, and the existing Direct Team-board read port /
 * TaskRuntime / TaskPanel consumers.
 * `TEST STAND-INS`: the temporary profile/installation/home roots, a scripted
 * deterministic LLM transport that returns legal model chunks, and the
 * VirtualTerminal.
 * `DELIBERATELY ABSENT`: the user's real DSH_HOME/credentials, network model
 * calls, a physical terminal and the Split Gateway (its own real Host/Client
 * case proves that boundary separately).
 *
 * Evidence tier: Direct L6 application composition. The board authority is the
 * official `agentTeam` Session projection; the task tools are the ONLY writer.
 *
 * @module @xmoon76/dsh-pi-tui/team-board-host-to-tui.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { startS4D3Application, type S4D3Application } from '../support/application-fixture.ts'

const SUBJECT = 'FR8_BOARD_TASK'
const DESCRIPTION = 'FR8 official task projection'

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

interface ToolScript {
  readonly kind: 'tool'
  readonly name: string
  readonly arguments: string
  readonly callId: string
}

/** A deterministic model transport that emits LEGAL provider chunks only, so
 *  every Team task write goes through the real conditional ToolRuntime
 *  admission and the official `agentTeam` authority. */
class ScriptedAdapter extends LlmAdapter {
  readonly scripts: ToolScript[] = []

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const script = this.scripts.shift()
    if (script === undefined) {
      yield* textChunks('ready')
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: script.callId as never,
      name: script.name,
      argumentsDelta: script.arguments,
    }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: script.callId as never, name: script.name, arguments: script.arguments },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** The official task TOOL result: the owner name rides `owner`. */
interface TeamTaskResult {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  readonly owner?: string
}

/** The official `agentTeam` wire projection: the owner name rides `ownerName`. */
interface TeamTaskView {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  readonly ownerId?: string
  readonly ownerName?: string
}

interface AgentTeamProjection {
  readonly enabled: boolean
  readonly tasks: readonly TeamTaskView[]
  readonly failure?: string
}

interface TeamModeService {
  isEnabled(agent: Agent): boolean
  setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void>
}

interface Harness {
  readonly app: S4D3Application
  readonly agent: Agent
  readonly adapter: ScriptedAdapter
  readonly team: TeamModeService
  readonly board: () => AgentTeamProjection
  readonly events: () => readonly { readonly type: string; readonly data: unknown }[]
  readonly toolResult: (callId: string) => string | undefined
  readonly typeLine: (line: string) => Promise<void>
}

async function startHarness(t: Parameters<typeof startS4D3Application>[0]): Promise<Harness & { secondProjections: { stateOf(session: unknown, key: string): unknown } }> {
  const adapter = new ScriptedAdapter()
  const app = await startS4D3Application(t, {
    bundles: [],
    presets: true,
    columns: 120,
    config: { fullscreen: 'on' },
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  const agent = await app.submitFirstPrompt('Coordinate a team task')
  const projections = app.host.ctx.get('sessionProjections') as { stateOf(session: unknown, key: string): unknown }
  const events = (): readonly { readonly type: string; readonly data: unknown }[] => agent.session.snapshotEvents() as never
  return {
    app,
    agent,
    adapter,
    team: app.host.ctx.get('agentTeams') as TeamModeService,
    secondProjections: projections,
    board: () => projections.stateOf(agent.session, 'agentTeam') as AgentTeamProjection,
    events,
    toolResult(callId): string | undefined {
      for (const event of events()) {
        if (event.type !== 'tool/result') continue
        const data = event.data as {
          readonly message?: { readonly toolCallId?: string; readonly content?: readonly { readonly text?: string }[] }
        }
        if (data.message?.toolCallId !== callId) continue
        return (data.message.content ?? []).map(block => block.text ?? '').join('')
      }
      return undefined
    },
    async typeLine(line: string): Promise<void> {
      for (const character of line) app.vt.sendInput(character)
      await app.settle() // render-turn window for the submitted input
      app.vt.sendInput('\r')

      await app.settle(60) // bounded observation window for a negative fact
    },
  }
}

/** Enable Team through the REAL `/model` Team row keyboard gesture. */
async function enableTeamThroughModelPicker(harness: Harness): Promise<void> {
  const { app } = harness
  for (const character of '/model') app.vt.sendInput(character)
  await app.settle() // render-turn window for the submitted input
  app.vt.sendInput('\r')
  await app.waitFor(() => app.view().includes('Agent Team'), 'the /model Team row')
  // Tab focuses the Team row; Enter is the official toggle.
  app.vt.sendInput('\t')
  await app.settle() // render-turn window for the submitted input
  app.vt.sendInput('\r')
  await app.waitFor(() => harness.team.isEnabled(harness.agent), 'the official Team service turns ON')
  await app.waitFor(() => /Agent Team\s+\[On\]\s+Off/u.test(app.view()), 'the picker reads the ON projection back')
  // Esc returns from the Team row to the model list and closes the picker.
  app.vt.sendInput('\x1b')
  await app.settle() // render-turn window for the submitted input
  app.vt.sendInput('\x1b')
  await app.waitFor(() => !app.view().includes('Reasoning Effort'), 'the picker closes')
}

/** One real model turn whose tool call is the official Team task write. */
async function runToolTurn(harness: Harness, script: ToolScript, prompt: string): Promise<void> {
  harness.adapter.scripts.push(script)
  harness.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  await harness.app.waitFor(() => harness.toolResult(script.callId) !== undefined, `the ${script.name} tool result`)
}

test('the official team_task_create/update projection renders on the mounted Team page', async t => {
  const harness = await startHarness(t)
  const { app, agent } = harness
  assert.equal(harness.team.isEnabled(agent), false, 'a fresh Root Session starts with Team OFF')
  assert.equal(harness.events().filter(event => event.type === 'team/mode').length, 0,
    'no durable team/mode exists before the user enables Team')

  await enableTeamThroughModelPicker(harness)
  assert.ok(harness.events().some(event => event.type === 'team/mode'), 'enablement is the official durable team/mode')

  // Real create: the model requests it, the conditional tool executes.
  await runToolTurn(harness, {
    kind: 'tool',
    name: 'team_task_create',
    callId: 'fr8-board-create',
    arguments: JSON.stringify({ subject: SUBJECT, description: DESCRIPTION }),
  }, 'Create the shared task')
  const created = JSON.parse(harness.toolResult('fr8-board-create') ?? '{}') as TeamTaskResult
  assert.equal(created.subject, SUBJECT)
  assert.equal(created.description, DESCRIPTION)
  assert.equal(created.status, 'pending')
  assert.equal(created.revision, 1)
  assert.equal(created.owner, undefined, 'a new task starts unowned')

  // Real update: the SAME call's result supplies the task identity and the
  // expected revision — nothing is invented by the test or by the UI.
  await runToolTurn(harness, {
    kind: 'tool',
    name: 'team_task_update',
    callId: 'fr8-board-update',
    arguments: JSON.stringify({
      task_id: created.id,
      expected_revision: created.revision,
      action: 'reassign',
      owner: 'lead',
    }),
  }, 'Reassign the shared task to the lead')
  const updated = JSON.parse(harness.toolResult('fr8-board-update') ?? '{}') as TeamTaskResult
  assert.equal(updated.id, created.id, 'the update addressed the SAME task the create returned')
  assert.equal(updated.revision, 2, 'the compare-and-set revision advanced exactly once')
  assert.equal(updated.status, 'in_progress')
  assert.equal(updated.owner, 'lead')

  // The authority is the official projection, not the tool JSON the UI reads.
  const projection = harness.board()
  assert.equal(projection.enabled, true)
  assert.equal(projection.tasks.length, 1)
  assert.equal(projection.tasks[0]?.id, created.id)
  assert.equal(projection.tasks[0]?.revision, updated.revision)
  assert.equal(projection.tasks[0]?.status, 'in_progress')
  assert.equal(projection.tasks[0]?.ownerName, 'lead')

  // The REAL /tasks entry paints the Team page from that projection.
  await harness.typeLine('/tasks')
  await app.waitFor(() => app.view().includes('Tasks · [Work]  Team'), 'the Tasks panel opens on Work')
  app.vt.sendInput('\t')
  await app.waitFor(() => app.view().includes('Tasks · Work  [Team]'), 'Tab switches to the Team page')
  await app.waitFor(() => app.view().includes('Agent Team: On (read-only)'), 'the read-only Team status')

  const page = app.view()
  assert.match(page, new RegExp(`${SUBJECT} · lead`, 'u'), `the shared task row is painted:\n${page}`)
  assert.match(page, /in_progress\s+FR8_BOARD_TASK/u, 'the row carries the official status word')
  // The page's OWN rows are read from the panel body, so a transcript tool card
  // that legitimately prints the tool's revision is never mistaken for a page
  // column. The read-only page offers no write verb.
  const teamBody = page.split('\n').filter(row => row.includes('│')).join('\n')
  assert.doesNotMatch(teamBody, /\brev\b/u, 'the page never invents an internal revision column')
  assert.doesNotMatch(teamBody, /\b(claim|assign|complete)\b/iu, 'the read-only page offers no write verb')

  // The two pages keep their OWN selection state across a round trip.
  app.vt.sendInput('\t')
  await app.waitFor(() => app.view().includes('Tasks · [Work]  Team'), 'back on the Work page')
  app.vt.sendInput('\t')
  await app.waitFor(() => app.view().includes('Tasks · Work  [Team]'), 'back on the Team page')
  assert.match(app.view(), new RegExp(`>?\\s*in_progress\\s+${SUBJECT}`, 'u'), 'the Team selection is still on the task')
  app.vt.sendInput('\x1b')
  await app.waitFor(() => !app.view().includes('Tasks · Work  [Team]'), 'Esc closes the Tasks panel')
  assert.equal(app.agent(), agent, 'the board stayed on the same live Session')
})

test('a Team-Off Session keeps the durable board but a different Session never borrows it', async t => {
  const harness = await startHarness(t)
  const { app, agent, secondProjections } = harness
  await enableTeamThroughModelPicker(harness)
  await runToolTurn(harness, {
    kind: 'tool',
    name: 'team_task_create',
    callId: 'fr8-board-off-create',
    arguments: JSON.stringify({ subject: SUBJECT, description: DESCRIPTION }),
  }, 'Create the shared task before turning Team off')
  const task = JSON.parse(harness.toolResult('fr8-board-off-create') ?? '{}') as TeamTaskView
  assert.equal(harness.board().tasks.length, 1)

  // Disabling Team keeps the durable board read-only.
  const teamMode = app.host.ctx.get('agentTeams') as { setEnabled(agent: Agent, enabled: boolean): Promise<void> }
  await teamMode.setEnabled(agent, false)
  await app.waitFor(() => harness.board().enabled === false, 'the official projection reports Team OFF')
  const retained = harness.board().tasks
  assert.equal(retained.length, 1, 'the disabled board retains its tasks')
  assert.equal(retained[0]?.id, task.id)

  // The Team page still shows the retained task and stays read-only.
  await harness.typeLine('/tasks')
  await app.waitFor(() => app.view().includes('Tasks · [Work]  Team'), 'the Tasks panel opens')
  app.vt.sendInput('\t')
  await app.waitFor(() => app.view().includes('Agent Team: Off'), 'the Team page reports OFF')
  assert.match(app.view(), new RegExp(SUBJECT, 'u'), 'the retained task is still listed')
  assert.match(app.view(), /Team is Off · Enable it from \/model/u, 'the page states the OFF fact')
  app.vt.sendInput('\x1b')
  await app.waitFor(() => !app.view().includes('Agent Team: Off'), 'Esc closes the Tasks panel')

  // A DIFFERENT Session's Team page never shows this Session's task. (The
  // child/root write-authority negative is already owned by
  // `test/integration/agent-team.test.ts`; this case only proves the board
  // READ never lends one Session's tasks to another.)
  app.vt.sendInput('\x1b')

  await app.settle(20) // bounded observation window for a negative fact
  await harness.typeLine('/new')
  await app.waitFor(() => app.agent() !== undefined && String(app.agent()!.session.id) !== String(agent.session.id),
    'the production /new Session transition')
  const second = app.requireAgent()
  assert.notEqual(String(second.session.id), String(agent.session.id))
  // The second Session's OWN official board is the positive control that makes
  // the negative meaningful: it must be a READY, enabled board with NO task.
  const secondBoard = (): AgentTeamProjection =>
    secondProjections.stateOf(second.session, 'agentTeam') as AgentTeamProjection
  await app.waitFor(() => Array.isArray(secondBoard()?.tasks), 'the second Session board is readable')
  assert.deepEqual(secondBoard().tasks, [], 'the second Session owns an EMPTY board')
  // HONEST LIMIT: the `agentTeam` projection omits `enabled` until a team/mode
  // write exists, so an absent flag means "no Team selection recorded for this
  // Session" — it is not a fabricated `false`. The official Team SERVICE is the
  // readback that the second Session really is OFF.
  assert.notEqual(secondBoard().enabled, true, 'the second Session has no enabled Team selection in its projection')
  assert.equal(harness.team.isEnabled(second), false, 'the official Team service reads the second Session as OFF')

  await harness.typeLine('/tasks')
  await app.waitFor(() => app.view().includes('Tasks · [Work]  Team'), 'the Tasks panel opens on the new Session')
  app.vt.sendInput('\t')
  // Wait for the Team page to be PAINTED with the second Session's own OFF
  // fact — that frame is the proof the read completed for THIS subject.
  await app.waitFor(() => app.view().includes('Agent Team: Off'), 'the second Session Team page is painted')
  const secondPage = app.view()
  assert.doesNotMatch(secondPage, new RegExp(SUBJECT, 'u'),
    'the previous Root Session\'s shared task never leaks into the new Session page')
  // The OFF page states the OFF fact instead of an empty-task line (the frozen
  // page contract), and it lists NO shared task row for this subject.
  assert.match(secondPage, /Tasks · Work  \[Team\]/u, 'the second Session Team page is the painted page')
  assert.match(secondPage, /Team is Off · Enable it from \/model/u, 'the second Session page states its own OFF board')
  assert.doesNotMatch(secondPage, /in_progress\s+FR8_BOARD_TASK/u, 'no shared task row belongs to the second Session')
})
