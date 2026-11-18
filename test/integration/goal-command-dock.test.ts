/**
 * The official `/goal` command reaches the mounted Goal Dock.
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the installed DSH rc.3 base /
 * `dsh-goal` / `dsh-command-goal` family, the shipped `standard` preset, the
 * official profile/patch reader and `boot()` Loader, the production TUI runner
 * mounted on the SAME Context, and the existing Direct status owner that folds
 * `goal/change` into the dock's single goal line.
 * `TEST STAND-INS`: the temporary profile/installation/home roots, a scripted
 * deterministic LLM transport and the VirtualTerminal.
 * `DELIBERATELY ABSENT`: the user's real DSH_HOME/credentials, network model
 * calls and a physical terminal.
 *
 * Evidence tier: Direct L6 application composition. The goal's durable
 * authority is the official `goal/change` event; the dock is its presentation.
 *
 * @module @xmoon76/dsh-pi-tui/goal-command-dock.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { foldGoal, goalTextOf } from '../../src/domain/status/derive-goal.ts'
import { startS4D3Application, type S4D3Application } from '../support/application-fixture.ts'
import { skippedInstallationReason } from '../support/optional-bundle-fixture.ts'

// The provisioned official DSH rc.3 base installation is the production
// prerequisite of every case here: without it the shared fixture reports
// BLOCKED_ENV, and the case is SKIPPED — never recorded as an L6 pass.
const skip = skippedInstallationReason([])

const OBJECTIVE = '完成 FR8 目标 🎯 并核查 long objective text 在短终端上仍保留完整的尾部标记 GOAL_TAIL_END_XYZ'
const EDITED = '改为新的目标 🚀 edited objective tail EDIT_TAIL_END'

class BasicAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ready' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ready' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface GoalChange {
  readonly operation: string
  readonly goal?: { readonly phase: string; readonly objective: string; readonly revision: number; readonly id: string }
}

/** The dock's single goal line, or undefined when no goal is displayed. */
function goalLine(view: string): string | undefined {
  return view.split('\n').map(line => line.trimEnd()).find(line => /(^|\s)goal\s+(●|‖|◌)\s/u.test(line))
}

function durableGoalChanges(agent: Agent): readonly GoalChange[] {
  return (agent.session.snapshotEvents() as readonly { type: string; data: unknown }[])
    .filter(event => event.type === 'goal/change')
    .map(event => event.data as GoalChange)
}

async function typeLine(app: S4D3Application, line: string): Promise<void> {
  for (const character of line) app.vt.sendInput(character)
  await app.settle() // render-turn window for the submitted input
  app.vt.sendInput('\r')

  await app.settle(60) // bounded observation window for a negative fact
}

test('the official /goal create, pause, edit and clear each reach the current Dock as the durable goal/change fact', { skip }, async t => {
  const adapter = new BasicAdapter()
  const app = await startS4D3Application(t, {
    bundles: [],
    presets: true,
    // A wide terminal so the dock line's own width budget never clips the
    // objective: the assertions below are about the FACT, not about fitting.
    columns: 160,
    config: { fullscreen: 'on' },
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  const agent = await app.submitFirstPrompt('Track an objective in this session')
  assert.equal(goalLine(app.view()), undefined, 'a fresh Session shows no goal line')

  // ── create ────────────────────────────────────────────────────────────────
  await typeLine(app, `/goal ${OBJECTIVE}`)
  const created = durableGoalChanges(agent).at(-1)
  assert.equal(created?.operation, 'create', 'the official /goal create is durable')
  assert.equal(created?.goal?.objective, OBJECTIVE, 'the durable objective keeps CJK, emoji and the tail marker')
  const activeGoal = created?.goal
  assert.ok(activeGoal !== undefined)
  assert.equal(goalTextOf(activeGoal), `goal ● ${OBJECTIVE}`)
  await app.waitFor(() => goalLine(app.view()) === `goal ● ${OBJECTIVE}`, 'the Dock renders the official active goal')

  // ── pause ─────────────────────────────────────────────────────────────────
  await typeLine(app, '/goal pause')
  const paused = durableGoalChanges(agent).at(-1)
  assert.equal(paused?.operation, 'pause', 'the official /goal pause is durable')
  assert.equal(paused?.goal?.phase, 'paused')
  await app.waitFor(() => goalLine(app.view()) === `goal ‖ ${OBJECTIVE}`, 'the Dock paints the paused mark')

  // ── edit ──────────────────────────────────────────────────────────────────
  await typeLine(app, `/goal edit ${EDITED}`)
  const edited = durableGoalChanges(agent).at(-1)
  assert.equal(edited?.operation, 'edit', 'the official /goal edit is durable')
  assert.equal(edited?.goal?.objective, EDITED)
  await app.waitFor(() => goalLine(app.view()) === `goal ‖ ${EDITED}`, 'the Dock follows the edited objective')

  // ── clear ─────────────────────────────────────────────────────────────────
  // The cleared tombstone is the durable fact; the SAME frame must stop
  // painting the retired goal without waiting for an unrelated status event.
  await typeLine(app, '/goal clear')
  const cleared = durableGoalChanges(agent).at(-1)
  assert.equal(cleared?.operation, 'clear', 'the official /goal clear is durable')
  assert.equal(foldGoal(agent.session.snapshotEvents() as never), undefined, 'the durable fold holds no goal after clear')
  await app.waitFor(() => goalLine(app.view()) === undefined, 'the Dock hides the cleared goal')

  // A clear removes the goal fact only: the Session's own log keeps every
  // command it ran, including the opening user message.
  const events = agent.session.snapshotEvents() as readonly { type: string; data: unknown }[]
  const commandRuns = events
    .filter(event => event.type === 'command/run')
    .map(event => (event.data as { readonly name?: string }).name)
  assert.deepEqual(commandRuns, ['goal', 'goal', 'goal', 'goal'], 'all four /goal invocations are durable command/run facts')
  const userMessages = events
    .filter(event => event.type === 'user/message')
    .map(event => ((event.data as { readonly content?: readonly { readonly text?: string }[] }).content ?? [])
      .map(block => block.text ?? '').join(''))
  assert.ok(userMessages.some(text => text.includes('Track an objective in this session')),
    'the opening user message stays in the durable transcript')
  await app.waitFor(() => app.view().includes('Goal cleared.'), 'the clear output stays visible in the transcript')
  assert.equal(app.agent(), agent, 'every command ran on the same live Session')
})

test('the Dock truncates at the terminal width, never at a fixed objective length', { skip }, async t => {
  const adapter = new BasicAdapter()
  const app = await startS4D3Application(t, {
    bundles: [],
    presets: true,
    columns: 60,
    config: { fullscreen: 'on' },
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  const agent = await app.submitFirstPrompt('Track a long objective')
  await typeLine(app, `/goal ${OBJECTIVE}`)

  // The durable fact keeps the WHOLE objective (no 24-character cut).
  const created = durableGoalChanges(agent).at(-1)
  assert.equal(created?.goal?.objective, OBJECTIVE)
  assert.ok(`goal ● ${OBJECTIVE}`.length > 60, 'the rendered goal is wider than the 60-column terminal')
  const full = goalTextOf(created!.goal!)
  assert.equal(full, `goal ● ${OBJECTIVE}`)

  // The painted line is the ONE width-aware truncation at the terminal sink.
  await app.waitFor(() => goalLine(app.view()) !== undefined, 'the Dock paints the long goal')
  const painted = goalLine(app.view()) ?? ''
  assert.ok(painted.startsWith('goal ● 完成 FR8 目标'), `the painted line keeps the leading fact: ${painted}`)
  assert.ok(painted.endsWith('…'), `a line wider than the terminal is truncated with the ellipsis: ${painted}`)
  assert.ok(painted.length < full.length, 'the painted line is shorter than the durable text')

  // A WIDER terminal redistributes the SAME fact instead of re-cutting a
  // stored 24-character summary: the tail becomes reachable again.
  app.vt.resize(200, 40)

  await app.settle(40) // bounded observation window for a negative fact
  await app.waitFor(() => goalLine(app.view()) === full, 'the widened Dock paints the whole durable objective')
})

test('a completed goal hides the Dock badge while the durable record stays', { skip }, async t => {
  const adapter = new BasicAdapter()
  const app = await startS4D3Application(t, {
    bundles: [],
    presets: true,
    columns: 160,
    config: { fullscreen: 'on' },
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  const agent = await app.submitFirstPrompt('Complete an objective')
  await typeLine(app, `/goal ${OBJECTIVE}`)
  await app.waitFor(() => goalLine(app.view()) !== undefined, 'the Dock paints the active goal')

  // The official goal service owns completion; drive it through the real
  // service the user's Session uses (no test-side session write).
  const goals = app.host.ctx.get('goals') as {
    complete(agent: Agent, ref: { readonly id: string; readonly revision: number }): unknown
  }
  const latest = durableGoalChanges(agent).at(-1)!
  goals.complete(agent, { id: latest.goal!.id, revision: latest.goal!.revision })
  await app.waitFor(() => goalLine(app.view()) === undefined, 'a completed goal hides the Dock badge')
  assert.equal(durableGoalChanges(agent).at(-1)?.goal?.phase, 'complete', 'the completion is the durable official fact')
  assert.equal(app.agent(), agent, 'the Dock kept the same Session')
})
