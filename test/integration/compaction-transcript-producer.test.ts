/**
 * PR2 C02 — REAL official compaction producer → production TranscriptFolder.
 *
 * Chain per case (no hand-written `data.turn` standing in for a producer):
 *
 *   scripted LLM request
 *     -> the REAL pinned DSH AgentLoop / Session store
 *     -> the REAL official BasicCompactionEngine (auto triggers disabled)
 *     -> its REAL `compactNow` (idle, `turn: null`) / `compactRegion`
 *        (open Turn, numeric owner) transaction
 *     -> the production `TranscriptFolder` and canonical projectors
 *
 * FIXTURE MANIFEST
 * - REAL: the pinned Cordis service composition, Session store, AgentLoop turn
 *   admission, official `BasicCompactionEngine` region transaction (lock,
 *   summary, replacement, end), its token-meter prerequisites, and the
 *   production TranscriptFolder/Focus/window projectors.
 * - STAND-INS: the scripted LlmAdapter (the conversation model), the controlled
 *   `summarize()` output (the summary body only — the transaction stays the
 *   official one), and disposable local storage roots.
 * - ABSENT: a physical terminal, OS pointer/IME input, the Remote transport and
 *   real provider cost. This proves producer semantics + the production
 *   presentation decision, not the L6 transport or G8.
 * @module @xmoon76/dsh-pi-tui/compaction-transcript-producer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {
  createUserMessage,
  LlmAdapter,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { isPostTurnReplayEvidence } from '../../src/domain/transcript/semantics.ts'
import { projectFocus, focusProjectionTurnOf } from '../../src/tui/transcript/focus-projection.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const MODEL = 'compaction-producer-mock'
const SIGNAL = new AbortController().signal
const PROMPT = 'older conversation history '.repeat(200)
const SUMMARY_BODY = 'PRODUCER_COMPACTION_SUMMARY'

/** The conversation model: one plain text answer per request. */
class TextAdapter extends LlmAdapter {
  readonly requests: number[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options.messages?.length ?? 0)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The official engine with ONLY the summarizer output controlled. */
class FixtureCompactionEngine extends BasicCompactionEngine {
  summarizeCalls = 0

  override async summarize(
    _input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<SummaryResult> {
    this.summarizeCalls += 1
    return {
      summary: [{ type: 'text', text: SUMMARY_BODY }] satisfies ContentBlock[],
      provider: 'fixture-summary',
      model: 'fixture-summary',
    }
  }
}

interface ProducerHarness {
  readonly ctx: Context
  readonly agent: Agent
  readonly compact: FixtureCompactionEngine
  readonly adapter: TextAdapter
}

async function bootProducer(life: ReturnType<typeof testLifecycle>, label: string): Promise<ProducerHarness> {
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new TextAdapter()
  ctx.llm.registerAdapter([MODEL], adapter)
  // `auto: false` disables pressure/model-switch/overflow triggers: every
  // compaction event in this file comes from the explicit official entry point.
  const compact = new FixtureCompactionEngine(ctx, { auto: false })
  const agent = await ctx.agentLoop.create(SessionId(label), { provider: MODEL, model: MODEL })
  return { ctx, agent, compact, adapter }
}

/** Drive one REAL turn so the closed history holds a compactable span. */
async function seedHistory(harness: ProducerHarness, text = PROMPT): Promise<void> {
  harness.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await harness.agent.whenIdle()
}

/** The first surface node that is not the system prompt head. */
function firstCompactableNode(agent: Agent): SessionSeq {
  const nodes = agent.session.surface.nodes
  const head = nodes[0]
  assert.ok(head !== undefined, 'fixture: the real session surface is not empty')
  const headEvent = agent.session.eventAt(head)
  assert.ok(headEvent !== undefined, 'fixture: the surface head has its durable event')
  return headEvent.type === 'system/message' ? nodes[1]! : head
}

test('the REAL compactNow idle path produces an independent (turn: null) compaction card', async (t) => {
  const life = testLifecycle(t)
  const harness = await bootProducer(life, 'idle-standalone')
  await seedHistory(harness)

  const result = await harness.compact.compactNow(harness.agent, SIGNAL)
  assert.ok(result !== null, 'the real idle compactNow succeeds on compactable history')
  assert.equal(harness.compact.summarizeCalls, 1, 'the official transaction drove the summary hook exactly once')
  assert.ok(result.shadowedSeqs.length > 0, 'the producer really shadowed a durable span')
  assert.equal(result.sourceCommandId, undefined, 'no command id was supplied to compactNow')

  const events = harness.agent.session.snapshotEvents()
  const start = events.findLast((event): event is Extract<SessionEvent, { type: 'compaction/start' }> =>
    event.type === 'compaction/start')
  const end = events.findLast((event): event is Extract<SessionEvent, { type: 'compaction/end' }> =>
    event.type === 'compaction/end')
  const summary = events.findLast((event): event is Extract<SessionEvent, { type: 'compaction/summary' }> =>
    event.type === 'compaction/summary')
  assert.ok(start !== undefined && end !== undefined && summary !== undefined)
  assert.equal(start.data.turn, null, 'the REAL producer declares the standalone maintenance owner')
  assert.equal(end.data.turn, null)
  assert.equal(summary.data.provider, 'fixture-summary', 'the official transaction wrote its summary')
  assert.match(JSON.stringify(summary.data.summary), new RegExp(SUMMARY_BODY, 'u'))

  const folder = new TranscriptFolder()
  folder.hydrate(events)
  const cards = folder.messages().filter(message => message.kind === 'compaction')
  assert.equal(cards.length, 1, 'the standalone lifecycle produces exactly ONE card')
  const card = cards[0]
  assert.ok(card !== undefined && card.kind === 'compaction')
  assert.equal('turn' in card, false, 'the visible card owns no model turn')
  assert.equal(card.running, false)
  assert.match(card.text, new RegExp(SUMMARY_BODY, 'u'))
  assert.equal(focusProjectionTurnOf(card), undefined, 'Focus treats the standalone card as a hard fence')
  assert.equal(isPostTurnReplayEvidence(card), false, 'a standalone idle card is not a late turn row')
  const realTurns = events
    .filter((event): event is Extract<SessionEvent, { type: 'turn/start' }> => event.type === 'turn/start')
    .map(event => event.data.turn)
  assert.deepEqual([...folder.turns()], realTurns,
    'no synthetic turn was registered by the compaction row')
  const focus = projectFocus(folder.messages(), folder.turnActivities(), new Set(), true)
  assert.equal(focus.filter(block => block.kind === 'message' && block.message === card).length, 1,
    'the standalone card renders exactly once in collapsed Focus')
  const latest = folder.window({ maxTurns: 20 })
  assert.ok(latest.messages.some(message => message.kind === 'compaction'),
    'the standalone card stays visible in the bounded window')
})

test('the REAL compactRegion open-turn path produces a numeric owner and a normal Context card', async (t) => {
  const life = testLifecycle(t)
  const harness = await bootProducer(life, 'numeric-auto')
  await seedHistory(harness)

  // NEGATIVE CONTROL in the same fixture: while a prompt already owns the next
  // turn, the idle manual entry point refuses BEFORE it can write a bracket.
  harness.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'blocking prompt' }],
    source: { kind: 'user' },
  }))
  // `compactNow` throws synchronously when maintenance admission refuses, so
  // wrap the call to observe the rejection (the upstream helper does the same).
  await assert.rejects(async () => harness.compact.compactNow(harness.agent, SIGNAL), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'busy',
      'the official manual path classifies the open turn as busy')
    return true
  })
  await harness.agent.whenIdle()
  assert.equal(harness.compact.summarizeCalls, 0, 'the rejected manual attempt summarized nothing')
  assert.ok(!harness.agent.session.snapshotEvents().some(event => event.type === 'compaction/start'),
    'the rejected manual attempt wrote no bracket')

  // The automatic numeric producer path: the official `compactRegion`
  // transaction (the SAME public entry automatic pressure/overflow use),
  // invoked between steps of a REAL open Turn over the already-closed history.
  const startSeq = firstCompactableNode(harness.agent)
  const endSeq = harness.agent.session.surface.nodes.at(-1)!
  let compacted: Awaited<ReturnType<FixtureCompactionEngine['compactRegion']>> | undefined
  harness.ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (compacted !== undefined) return next()
    compacted = await harness.compact.compactRegion(startSeq, endSeq, agent, SIGNAL)
    return next()
  })
  harness.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'numeric automatic turn' }],
    source: { kind: 'user' },
  }))
  await harness.agent.whenIdle()
  assert.ok(compacted !== undefined, 'the official compactRegion transaction ran inside the open turn')
  assert.equal(harness.compact.summarizeCalls, 1)

  const events = harness.agent.session.snapshotEvents()
  const start = events.findLast((event): event is Extract<SessionEvent, { type: 'compaction/start' }> =>
    event.type === 'compaction/start')
  assert.ok(start !== undefined)
  const owner = start.data.turn
  assert.equal(typeof owner, 'number', 'the open-turn producer writes a REAL numeric owner')
  const openTurnStart = events.filter((event): event is Extract<SessionEvent, { type: 'turn/start' }> =>
    event.type === 'turn/start' && event.seq < start.seq).at(-1)
  assert.ok(openTurnStart !== undefined && openTurnStart.data.turn === owner,
    'the numeric owner is the enclosing REAL turn, not a rebound/current value')
  const end = events.findLast((event): event is Extract<SessionEvent, { type: 'compaction/end' }> =>
    event.type === 'compaction/end')
  assert.equal(end?.data.turn, owner, 'start and end share the ONE owner')

  const folder = new TranscriptFolder()
  folder.hydrate(events)
  const card = folder.messages().find(message => message.kind === 'compaction')
  assert.ok(card !== undefined && card.kind === 'compaction')
  assert.equal(card.turn, owner, 'the visible card keeps the producer numeric owner')
  assert.equal(focusProjectionTurnOf(card), owner, 'Focus keeps the numeric card in its real Turn')
  assert.equal(isPostTurnReplayEvidence(card), false, 'an in-turn automatic card is not replay evidence')
  const realTurns = events
    .filter((event): event is Extract<SessionEvent, { type: 'turn/start' }> => event.type === 'turn/start')
    .map(event => event.data.turn)
  assert.deepEqual([...folder.turns()], realTurns,
    'the numeric compaction adds no ghost/split turn to the real turn index')
  assert.equal(folder.groupedTurns().filter(turn => turn === owner).length, 1,
    'the numeric card registers its own turn exactly once')
  const latest = folder.window({ maxTurns: 2 })
  assert.equal(latest.messages.filter(message => message.kind === 'compaction').length, 1,
    'the numeric card is reachable in the real turn window')
})
