/**
 * The official `exit_plan_mode` review reaches the MOUNTED PiTui application.
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the installed DSH rc.3 base /
 * `dsh-plan-mode` / `user-questions` / Session / Agent / ToolRuntime family,
 * the shipped `standard` preset (its real `plan-mode` row), the official
 * profile/patch reader and `boot()` Loader, the production TUI runner
 * (`src/index.ts::apply`) mounted on the SAME Context, and the existing Direct
 * Plan-status / Question consumers.
 * `TEST STAND-INS`: the temporary profile/installation/home roots, a scripted
 * deterministic LLM transport that returns legal model chunks, and the
 * VirtualTerminal.
 * `DELIBERATELY ABSENT`: the user's real DSH_HOME/credentials, network model
 * calls, a physical terminal/mouse and the Split Gateway (the Split lane proves
 * that boundary separately).
 *
 * Evidence tier: Direct L6 application composition (an official in-process Host
 * Tool/Question plus the real runner on a mounted VirtualTerminal). It is NOT
 * L5, which is reserved for the authenticated generated Client wire.
 *
 * @module @xmoon76/dsh-pi-tui/plan-review-host-to-tui.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { startS4D3Application, type S4D3Application } from '../support/application-fixture.ts'

const PLAN = '# FR8 official plan\n- 检查真实 Host\n- 保存会话事实\n\nFR8_PLAN_TAIL_END'
const APPROVED_RESULT = 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
const DISMISSED_RESULT = 'The user dismissed the plan review to reply in their own words; plan mode remains active.'

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

/** A deterministic model transport that emits LEGAL provider chunks only — a
 *  text reply, or one standard `tool-call` block the real ToolRuntime admits
 *  and executes. It never calls a Host service directly. */
class ScriptedAdapter extends LlmAdapter {
  readonly scripts: ToolScript[] = []
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push(options)
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

interface DurableEvent {
  readonly type: string
  readonly data: unknown
}

/** The official `plan` projection state (the same structural read the runner's
 *  Direct status owner performs). */
interface PlanProjection {
  readonly active: boolean
  readonly wanted: boolean | null
  readonly running: { readonly wanted: boolean } | null
}

/** The official `userQuestions` projection view (open + settled calls). */
interface QuestionProjection {
  readonly questions?: {
    readonly active?: readonly {
      readonly callId: string
      readonly questions: readonly {
        readonly id: string
        readonly detail?: string
        readonly intent?: { readonly kind?: string; readonly approve?: string; readonly callId?: string }
      }[]
    }[]
    readonly settled?: readonly {
      readonly callId: string
      readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
    }[]
  }
}

interface ToolOutcome {
  readonly content: string
  readonly isError: boolean
  readonly errorCode: string | undefined
}

interface Harness {
  readonly app: S4D3Application
  readonly agent: Agent
  readonly adapter: ScriptedAdapter
  readonly events: () => readonly DurableEvent[]
  readonly plan: () => PlanProjection
  readonly questions: () => QuestionProjection
  readonly toolOutcome: (callId: string) => ToolOutcome | undefined
  readonly indexOf: (callId: string, type: 'tool/call' | 'tool/result') => number
  readonly typeLine: (line: string) => Promise<void>
}

const PROJECTION_READY_TIMEOUT_MS = 60_000

/** The mounted application on ONE real Root Session created by a real model
 *  turn through the production draft path. */
async function startHarness(t: Parameters<typeof startS4D3Application>[0]): Promise<Harness> {
  const adapter = new ScriptedAdapter()
  const app = await startS4D3Application(t, {
    bundles: [],
    presets: true,
    config: { fullscreen: 'on' },
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  const agent = await app.submitFirstPrompt('Qualify the plan review in this session')
  // The draft's first real turn must SETTLE before a `/plan` gesture: an idle
  // Agent commits the selection immediately, while an open turn queues it for
  // the next pre-step (both legal, but this harness proves the committed path).
  await agent.whenIdle()
  await app.settle() // render-turn window for the submitted input
  const projections = app.host.ctx.get('sessionProjections') as {
    stateOf(session: unknown, key: 'plan' | 'userQuestions'): unknown
  }
  const events = (): readonly DurableEvent[] => agent.session.snapshotEvents() as never
  const callIdOf = (data: unknown): string | undefined => {
    const record = data as {
      readonly callId?: unknown
      readonly message?: { readonly toolCallId?: unknown }
    }
    if (typeof record.callId === 'string') return record.callId
    return typeof record.message?.toolCallId === 'string' ? record.message.toolCallId : undefined
  }
  return {
    app,
    agent,
    adapter,
    events,
    plan: () => projections.stateOf(agent.session, 'plan') as PlanProjection,
    questions: () => projections.stateOf(agent.session, 'userQuestions') as QuestionProjection,
    toolOutcome(callId): ToolOutcome | undefined {
      for (const event of events()) {
        if (event.type !== 'tool/result' || callIdOf(event.data) !== callId) continue
        const data = event.data as {
          readonly message?: { readonly isError?: boolean; readonly content?: readonly { readonly text?: string }[] }
          readonly error?: { readonly code?: string }
        }
        return {
          content: (data.message?.content ?? []).map(block => block.text ?? '').join(''),
          isError: data.message?.isError === true,
          errorCode: data.error?.code,
        }
      }
      return undefined
    },
    indexOf: (callId, type) => events().findIndex(event => event.type === type && callIdOf(event.data) === callId),
    async typeLine(line: string): Promise<void> {
      for (const character of line) app.vt.sendInput(character)
      await app.settle() // render-turn window for the submitted input
      app.vt.sendInput('\r')

      await app.settle(40) // bounded observation window for a negative fact
    },
  }
}

/** The official tool result of one call, committed through the real runtime. */
function requireOutcome(harness: Harness, callId: string): ToolOutcome {
  const outcome = harness.toolOutcome(callId)
  assert.ok(outcome !== undefined, `the official tool/result for ${callId} is committed`)
  return outcome
}

/** Type the real `/plan` command and wait for its OWN durable command to
 *  settle before reading the plan projection. */
async function enterPlanMode(harness: Harness): Promise<void> {
  const activeBefore = harness.events()
    .filter(event => event.type === 'plan/mode' && (event.data as { readonly active: boolean }).active === true).length
  await harness.typeLine('/plan')
  await harness.app.waitFor(
    () => harness.events()
      .filter(event => event.type === 'plan/mode' && (event.data as { readonly active: boolean }).active === true).length > activeBefore,
    'the official /plan command commits plan mode',
    PROJECTION_READY_TIMEOUT_MS,
  )
  assert.equal(harness.plan().active, true, 'the official /plan command commits plan mode')
}

/** The first durable `plan/mode` write AFTER the given event index. */
function planModeAfter(harness: Harness, index: number): { readonly active: boolean; readonly at: number } | undefined {
  const events = harness.events()
  for (let cursor = index + 1; cursor < events.length; cursor += 1) {
    const event = events[cursor]
    if (event?.type !== 'plan/mode') continue
    return { active: (event.data as { readonly active: boolean }).active, at: cursor }
  }
  return undefined
}

test('the official exit_plan_mode review approves through the mounted Question seat and exits plan mode only at the next accepted pre-step', async t => {
  const harness = await startHarness(t)
  const { app, adapter, agent } = harness
  assert.equal(harness.plan().active, false, 'a fresh Root Session starts outside plan mode')

  // The REAL `/plan` command enters plan mode.
  await enterPlanMode(harness)
  assert.ok(harness.events().some(event => event.type === 'plan/mode'), 'plan entry is a durable plan/mode event')

  // The NEXT real model step runs under plan mode and its own model request
  // carries the official exit tool; the scripted transport answers with that
  // tool call (never a test-side `userQuestions.ask`).
  adapter.scripts.push({
    kind: 'tool',
    name: 'exit_plan_mode',
    callId: 'fr8-plan-approve',
    arguments: JSON.stringify({ plan: PLAN }),
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Present the plan for review' }], source: { kind: 'user' } }))
  await app.waitFor(() => app.view().includes('View plan'), 'the mounted plan-review decision seat', PROJECTION_READY_TIMEOUT_MS)

  // The review identity is the OFFICIAL tool call, and the plan body the flow
  // reads is that call's own argument (not an injected question DTO).
  const planCall = harness.events()
    .filter(event => event.type === 'tool/call')
    .map(event => event.data as { readonly callId?: unknown; readonly name?: unknown; readonly arguments?: unknown })
    .find(call => call.name === 'exit_plan_mode')
  assert.equal(String(planCall?.callId), 'fr8-plan-approve', 'the review identity is the official tool call id')
  assert.deepEqual(JSON.parse(String(planCall?.arguments)), { plan: PLAN })

  // The reviewed card must be PAINTED in the mounted transcript before the
  // reading row can locate it: the View capability is a live proof over the
  // real card, not an optimistic flag.
  await app.waitFor(() => app.view().includes('exit_plan_mode · # FR8 official plan'), 'the reviewed card row')
  const decision = app.view()
  assert.match(decision, /> View plan/u, 'the fullscreen decision seat opens on View plan')
  assert.match(decision, /Keep planning…/u)
  assert.match(decision, /Approve plan/u)
  assert.doesNotMatch(decision, /View review text/u, 'the provable transcript card is the reading entry (no fallback row)')

  // Enter on View plan reads the SAME mounted transcript: the plan body and its
  // tail are painted, and Esc returns to the decision without answering.
  app.vt.sendInput('\r')
  await app.waitFor(() => app.view().includes('Reading the submitted plan'), 'the plan reading step')
  await app.waitFor(() => app.view().includes('FR8_PLAN_TAIL_END'), 'the plan body tail inside the reading viewport')
  assert.equal(harness.toolOutcome('fr8-plan-approve'), undefined, 'reading settles no tool result')
  app.vt.sendInput('\x1b')
  await app.waitFor(() => app.view().includes('View plan'), 'Esc returns to the decision list')
  assert.equal(harness.toolOutcome('fr8-plan-approve'), undefined, 'a reading Esc never settles the tool')

  // ↓↓ select the OFFICIAL Approve row and Enter.
  app.vt.sendInput('\x1b[B')
  app.vt.sendInput('\x1b[B')
  await app.waitFor(() => /> Approve plan/u.test(app.view()), 'the cursor reaches the Approve row')
  app.vt.sendInput('\r')
  await app.waitFor(() => harness.toolOutcome('fr8-plan-approve') !== undefined, 'the official tool result')

  const outcome = requireOutcome(harness, 'fr8-plan-approve')
  assert.equal(outcome.isError, false, 'an approved review is not a tool error')
  assert.equal(outcome.content, APPROVED_RESULT, 'the official approve result is committed verbatim')
  assert.equal(harness.events().filter(event => event.type === 'tool/result').length, 1,
    'the reviewed call settles exactly once (no duplicate official result)')

  // The approval is NOT itself the plan exit: the durable `plan/mode=false`
  // lands inside the NEXT accepted pre-step, after this step ended.
  await app.waitFor(
    () => harness.events().some(event => event.type === 'plan/mode' && (event.data as { readonly active: boolean }).active === false),
    'the next accepted pre-step commits plan mode off',
    PROJECTION_READY_TIMEOUT_MS,
  )
  const resultIndex = harness.indexOf('fr8-plan-approve', 'tool/result')
  const off = planModeAfter(harness, resultIndex)
  assert.ok(off !== undefined, 'a plan/mode write follows the approve result')
  assert.equal(off.active, false, 'the FIRST plan/mode after the approve result is the exit')
  const events = harness.events()
  assert.ok(events.slice(resultIndex, off.at).some(event => event.type === 'step/end'),
    'the exiting mode write follows the step that ended')
  const stepAfter = events.slice(off.at).findIndex(event => event.type === 'step/start')
  assert.ok(stepAfter >= 0, 'a following accepted step owns the mode write')

  // The user-visible terminal state agrees: the badge and the composer hint are
  // gone, and the review stayed on the SAME live Session.

  await app.settle(120) // bounded observation window for a negative fact
  const final = app.view()
  assert.doesNotMatch(final, /\[plan\]/u, `the plan badge is cleared:\n${final}`)
  assert.doesNotMatch(final, /Plan mode · /u, 'the composer no longer offers the plan-mode hint')
  assert.equal(app.agent(), agent, 'the review stayed on the same live Session')
})

test('a Keep planning answer keeps plan mode active and returns the feedback text through the official tool error', async t => {
  const harness = await startHarness(t)
  const { app, adapter, agent } = harness
  await enterPlanMode(harness)
  adapter.scripts.push({
    kind: 'tool',
    name: 'exit_plan_mode',
    callId: 'fr8-plan-keep',
    arguments: JSON.stringify({ plan: PLAN }),
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Present the plan again' }], source: { kind: 'user' } }))
  await app.waitFor(() => app.view().includes('Keep planning…'), 'the decision seat', PROJECTION_READY_TIMEOUT_MS)

  // ↓ then Enter opens the feedback step; Esc there is a local back, never an
  // answer.
  app.vt.sendInput('\x1b[B')
  app.vt.sendInput('\r')
  await app.waitFor(() => app.view().includes('Request changes'), 'the keep-planning feedback step')
  app.vt.sendInput('\x1b')
  await app.waitFor(() => app.view().includes('View plan'), 'Esc leaves the feedback edit back to the decision list')
  assert.equal(harness.toolOutcome('fr8-plan-keep'), undefined, 'a feedback Esc settles nothing')

  // Re-enter and submit a CJK + spaces revision request. The Esc back kept the
  // decision cursor on `Keep planning…`, so Enter alone re-opens the edit.
  const feedback = '请修改第 2 步 的 验收条件'
  await app.waitFor(() => /> Keep planning…/u.test(app.view()), 'the cursor stays on Keep planning')
  app.vt.sendInput('\r')
  await app.waitFor(() => app.view().includes('Request changes'), 'the feedback step again')
  for (const character of feedback) app.vt.sendInput(character)
  await app.settle() // render-turn window for the submitted input
  app.vt.sendInput('\r')
  await app.waitFor(() => harness.toolOutcome('fr8-plan-keep') !== undefined, 'the official keep-planning result')

  const outcome = requireOutcome(harness, 'fr8-plan-keep')
  assert.equal(outcome.isError, true, 'Keep planning is the official "keep planning" feedback path')
  assert.match(outcome.content, /keep planning/iu)
  assert.match(outcome.content, /请修改第 2 步 的 验收条件/u, 'the tool feedback returns the authored text verbatim')
  assert.equal(harness.plan().active, true, 'plan mode stays active after Keep planning')
  assert.equal(
    harness.events().filter(event => event.type === 'plan/mode' && (event.data as { readonly active: boolean }).active === false).length,
    0,
    'no plan/mode exit was ever committed',
  )
  assert.equal(harness.events().filter(event => event.type === 'tool/result').length, 1, 'the call settles exactly once')
})

test('a dismissed review concludes the turn with approved:false and never writes a plan exit', async t => {
  const harness = await startHarness(t)
  const { app, adapter, agent } = harness
  await enterPlanMode(harness)
  adapter.scripts.push({
    kind: 'tool',
    name: 'exit_plan_mode',
    callId: 'fr8-plan-dismiss',
    arguments: JSON.stringify({ plan: PLAN }),
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Present the plan once more' }], source: { kind: 'user' } }))
  await app.waitFor(() => app.view().includes('View plan'), 'the decision seat', PROJECTION_READY_TIMEOUT_MS)
  const turnsBefore = harness.events().filter(event => event.type === 'turn/start').length

  // Esc at the DECISION step is the official dismiss (a local back only inside
  // the reading/feedback steps).
  app.vt.sendInput('\x1b')
  await app.waitFor(() => harness.toolOutcome('fr8-plan-dismiss') !== undefined, 'the official dismiss result')
  await app.waitFor(() => !app.view().includes('Approve plan'), 'the decision seat closes')

  const outcome = requireOutcome(harness, 'fr8-plan-dismiss')
  assert.equal(outcome.isError, false, 'a dismiss is a normal tool result, not a tool failure')
  assert.equal(outcome.content, DISMISSED_RESULT, 'the official dismiss result is committed verbatim')
  assert.equal(harness.events().filter(event => event.type === 'tool/result').length, 1,
    'the dismissed call settles exactly once (no second result, no approve)')
  assert.equal(harness.plan().active, true, 'plan mode remains active after a dismiss')
  assert.equal(
    harness.events().filter(event => event.type === 'plan/mode' && (event.data as { readonly active: boolean }).active === false).length,
    0,
    'a dismiss never writes a plan exit',
  )
  // `concludeTurn()` ends the turn instead of spending a model request waiting.

  await app.settle(120) // bounded observation window for a negative fact
  assert.equal(harness.events().filter(event => event.type === 'turn/start').length, turnsBefore,
    'a dismissed review spends no further model turn')
  assert.doesNotMatch(app.view(), /Approve plan/u, 'the seat is really gone')
})

test('an ordinary ask_user_question keeps the generic Question/Review flow and a repeated Enter never writes a second answer', async t => {
  const harness = await startHarness(t)
  const { app, adapter, agent } = harness
  adapter.scripts.push({
    kind: 'tool',
    name: 'ask_user_question',
    callId: 'fr8-generic-question',
    arguments: JSON.stringify({
      questions: [{
        id: 'fr8-generic',
        header: 'Generic question',
        question: 'Continue the qualification?',
        options: [{ label: 'Proceed' }, { label: 'Cancel' }],
      }],
    }),
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Ask the generic question' }], source: { kind: 'user' } }))
  await app.waitFor(() => app.view().includes('Continue the qualification?'), 'the generic question form', PROJECTION_READY_TIMEOUT_MS)

  const form = app.view()
  assert.doesNotMatch(form, /View plan/u, 'a non-plan question offers no plan reading row')
  assert.doesNotMatch(form, /Approve plan/u, 'a non-plan question offers no approval row')
  // The generic tool call is durable; the `userQuestions` projection records
  // only TIMED calls, so this class is read from the Session log.
  assert.equal(harness.indexOf('fr8-generic-question', 'tool/call') >= 0, true,
    'the generic question is the official ask_user_question tool call')

  // Select the first option, then the Review page; the Review page's Enter is
  // the one submission (no default-approve shortcut).
  app.vt.sendInput('\r')
  await app.waitFor(() => /Review/u.test(app.view()), 'the generic Review page')
  app.vt.sendInput('\r')
  await app.waitFor(() => harness.toolOutcome('fr8-generic-question') !== undefined, 'the generic tool result')

  const outcome = requireOutcome(harness, 'fr8-generic-question')
  assert.equal(outcome.isError, false, 'the generic answer is a normal tool result')
  assert.match(outcome.content, /Proceed/u, 'the official answer content reaches the tool result')

  // A repeated Enter after the settlement must not write a second answer or
  // produce a second official tool result.
  app.vt.sendInput('\r')

  await app.settle(80) // bounded observation window for a negative fact
  assert.equal(harness.events().filter(event => event.type === 'tool/result').length, 1,
    'the settled call produces exactly one tool result')
  assert.equal(harness.events().filter(event => event.type === 'tool/call').length, 1,
    'a repeated Enter issues no second official call')
})
