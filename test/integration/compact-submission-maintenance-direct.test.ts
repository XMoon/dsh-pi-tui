/**
 * The official manual `/compact` maintenance window, proven on the REAL Direct
 * composition.
 *
 * This suite qualifies the Compact Submission exception end to end:
 *
 *     official `/compact` definition → real `CommandRuntime.execute` → real
 *     `BasicCompactionEngine` → real `AgentLoop.runMaintenance` (the durable
 *     `compaction/start` bracket) → an ordinary queued prompt accepted into the
 *     REAL Agent Inbox while the summary is still held → the maintenance ends
 *     → exactly one durable `user/message` and exactly one model turn
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - `@deepseek-ai/dsh-agent-loop` (real Agent, Inbox, wake), the official
 *   `@deepseek-ai/dsh-commands` `CommandRuntime`, the official
 *   `@deepseek-ai/dsh-command-compact` definition and the official
 *   `@deepseek-ai/dsh-compaction-basic` engine with the official `TokenMeter`
 * - the Direct `DirectHostCommandPort` and `DirectSessionWriter` adapters
 * - (the application case) the real `TuiApp` + `SubmissionController` over the
 *   real Direct Host composition in `test/support/direct-tsp-fixture.ts`
 *
 * TEST STAND-INS
 * - the summarizer: a GATED override in the engine subclass (the plan's
 *   controlled summarizer). Everything around it — transaction, markers,
 *   maintenance claim, Inbox and persistence — stays real.
 * - the model endpoint: the fixture's scripted streaming `LlmAdapter`
 *
 * DELIBERATELY ABSENT
 * - a physical Tern/IME/mouse client, the Remote split-process wire and any
 *   external provider network call. None of them is claimed as verified here.
 *
 * @module @xmoon76/dsh-pi-tui/compact-submission-maintenance-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as CommandCompact from '@deepseek-ai/dsh-command-compact'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DirectHostCommandPort } from '../../src/runtime/direct/host-command-direct.ts'
import { DirectSessionWriter } from '../../src/runtime/direct/session-writer-direct.ts'
import {
  createDirectTspFixture,
  directSettle,
  ScriptedStreamingAdapter,
  waitFor,
  waitForInputDelivery,
  type DirectTspFixture,
} from '../support/direct-tsp-fixture.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

type SummarizeArgs = Parameters<BasicCompactionEngine['summarize']>
type SummarizeResult = Awaited<ReturnType<BasicCompactionEngine['summarize']>>

/**
 * The REAL engine with the ONE controlled stand-in: summarization is held on an
 * explicit gate (and can be failed) before the transaction continues. The
 * durable `compaction/start` marker is already appended by the production
 * `compactSurfaceRegion` at the moment this hook runs.
 */
class GatedCompactionEngine extends BasicCompactionEngine {
  /** Held before the summary result is produced. */
  gate: Promise<void> = Promise.resolve()
  /** Thrown instead of a summary result when set (the failure negative). */
  failure: unknown
  /** Resolved once the real transaction reached summarization. */
  summarizeEntries = 0

  override async summarize(...args: SummarizeArgs): Promise<SummarizeResult> {
    void args
    this.summarizeEntries += 1
    await this.gate
    if (this.failure !== undefined) throw this.failure
    return {
      summary: [{ type: 'text', text: 'checkpoint: condensed older history' }],
      provider: 'scripted',
      model: 'scripted-model',
    }
  }
}

const SEED_TEXT = 'older conversation history for the maintenance qualification '
const PROMPT_TEXT = 'a queued prompt accepted during maintenance'
/** A TUI seed long enough that the gated summary is genuinely SMALLER than the
 *  shadowed span; the pinned engine rejects a summary that does not shrink. */
const TUI_SEED_TEXT = 'older conversation history for the maintenance qualification '.repeat(60)

interface HostUnderTest {
  readonly ctx: Context
  readonly agent: Agent
  readonly engine: GatedCompactionEngine
  readonly port: DirectHostCommandPort
  readonly writer: DirectSessionWriter
  seed(): Promise<void>
  dispose(): Promise<void>
}

/**
 * Mount the real Direct Host command/compaction chain over a real AgentLoop.
 */
async function mountHost(): Promise<HostUnderTest> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(TokenMeter)
  ctx.llm.registerAdapter(['scripted'], new ScriptedStreamingAdapter(['seed', '-answer']))
  const engine = new GatedCompactionEngine(ctx, { auto: false } as never)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin({
    name: CommandCompact.name,
    inject: CommandCompact.inject,
    apply: CommandCompact.apply,
  } as never, undefined as never)
  const agent = await harness.create(SessionId('compact-maintenance-direct'), {
    provider: 'scripted',
    model: 'scripted-model',
  })
  const agentFor = (sessionId: string): Agent | undefined =>
    sessionId === agent.session.id ? agent : undefined
  return {
    ctx,
    agent,
    engine,
    port: new DirectHostCommandPort({ get: (name: string) => ctx.get(name) }, agentFor),
    writer: new DirectSessionWriter({ get: (name: string) => ctx.get(name) }, agentFor),
    async seed() {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: SEED_TEXT.repeat(60) }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
    },
    async dispose() {
      for (const runtime of [...ctx.registry.values()]) {
        for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
      }
    },
  }
}

function userMessages(events: readonly SessionEvent[], text: string): SessionEvent[] {
  return events.filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes(text))
}

function turnStarts(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter(event => event.type === 'turn/start')
}

test('a queued prompt is accepted into the real Inbox during a held official compact and starts exactly one turn after it', async (t) => {
  const life = testLifecycle(t)
  const host = await mountHost()
  t.after(() => host.dispose())
  const { promise: summaryGate, resolve: releaseSummary } = Promise.withResolvers<void>()
  life.defer(() => releaseSummary())
  host.engine.gate = summaryGate
  await host.seed()
  const seedEvents = host.agent.session.snapshotEvents()
  assert.equal(userMessages(seedEvents, SEED_TEXT).length, 1, 'the seed turn is a real closed turn')
  const seedTurns = turnStarts(seedEvents).length

  let entered = 0
  const command = host.port.execute({
    sessionId: host.agent.session.id,
    line: '/compact',
    attachments: [],
    signal: new AbortController().signal,
    onOfficialCompactEntered: () => { entered += 1 },
  })
  assert.equal(entered, 1,
    'the real official compact definition + paired durable marker open the ordering window once')
  assert.equal(host.agent.status, 'idle',
    'the maintenance phase reports idle: status is NOT the maintenance proof')
  await waitFor('the real compaction transaction to reach summarization',
    () => host.engine.summarizeEntries === 1)
  const eventsDuringSummary = host.agent.session.snapshotEvents()
  assert.ok(eventsDuringSummary.some(event => event.type === 'compaction/start'),
    'the durable opening marker is already on the real log')
  assert.ok(!eventsDuringSummary.some(event => event.type === 'compaction/end'),
    'the summary is still held: the transaction is open')

  let accepted = 0
  const write = await host.writer.prompt(host.agent.session.id, createUserMessage({
    content: [{ type: 'text', text: PROMPT_TEXT }],
    source: { kind: 'user' },
  }), 'queue', { onAccepted: () => { accepted += 1 } })
  assert.equal(write.kind, 'committed', 'the Host accepted the queued prompt')
  assert.equal(accepted, 1, 'the official Host acceptance fired exactly once')
  const heldEvents = host.agent.session.snapshotEvents()
  assert.equal(userMessages(heldEvents, PROMPT_TEXT).length, 0,
    'the accepted prompt is parked in the Inbox, not consumed by the maintenance')
  assert.equal(turnStarts(heldEvents).length, seedTurns,
    'no model turn started while the maintenance is open')

  releaseSummary()
  const outcome = await command
  assert.equal(outcome.kind, 'committed', 'the official command settles normally')
  assert.ok(outcome.kind === 'committed' && outcome.matched)
  await host.agent.whenIdle()
  const settled = host.agent.session.snapshotEvents()
  const start = settled.find(event => event.type === 'compaction/start')
  const end = settled.find(event => event.type === 'compaction/end')
  const done = settled.find(event => event.type === 'command/done')
  assert.ok(start !== undefined && end !== undefined && done !== undefined,
    'the official transaction and the command lifecycle both terminated')
  assert.equal(end.data !== undefined && 'error' in end.data, false, 'the compaction closed without an error')
  const delivered = userMessages(settled, PROMPT_TEXT)
  assert.equal(delivered.length, 1, 'the accepted prompt is delivered exactly once')
  assert.ok(delivered[0]!.seq > end.seq, 'delivery happens after the maintenance bracket closes')
  assert.equal(turnStarts(settled).length, seedTurns + 1, 'exactly one new model turn ran')
  assert.ok(turnStarts(settled).at(-1)!.seq > end.seq, 'that turn starts after the maintenance bracket closes')
})

test('a failed official compact summary still ends its bracket and keeps the accepted prompt deliverable once', async (t) => {
  const life = testLifecycle(t)
  const host = await mountHost()
  t.after(() => host.dispose())
  const { promise: summaryGate, resolve: releaseSummary } = Promise.withResolvers<void>()
  life.defer(() => releaseSummary())
  host.engine.gate = summaryGate
  host.engine.failure = new Error('summarizer exploded')
  await host.seed()
  const seedTurns = turnStarts(host.agent.session.snapshotEvents()).length

  const command = host.port.execute({
    sessionId: host.agent.session.id,
    line: '/compact',
    attachments: [],
    signal: new AbortController().signal,
    onOfficialCompactEntered: () => {},
  })
  await waitFor('the real compaction transaction to reach summarization',
    () => host.engine.summarizeEntries === 1)
  let accepted = 0
  const write = await host.writer.prompt(host.agent.session.id, createUserMessage({
    content: [{ type: 'text', text: PROMPT_TEXT }],
    source: { kind: 'user' },
  }), 'queue', { onAccepted: () => { accepted += 1 } })
  assert.equal(write.kind, 'committed')
  assert.equal(accepted, 1)
  assert.equal(userMessages(host.agent.session.snapshotEvents(), PROMPT_TEXT).length, 0,
    'the prompt is accepted and pending while the failing summary is still held')

  releaseSummary()
  const outcome = await command
  // The pinned engine classifies a failed manual summary as an expected
  // `ManualCompactionError('summary')`; the official definition turns that into a
  // settled command ERROR result — never an indeterminate dispatch.
  assert.equal(outcome.kind, 'committed', 'the official command still settles')
  assert.ok(outcome.kind === 'committed' && outcome.matched)
  const failure = (outcome.execution as { result: { kind: string; text: string } }).result
  assert.equal(failure.kind, 'error', 'the summary failure is the official command error result')
  assert.match(failure.text, /could not produce a useful summary/)
  await host.agent.whenIdle()
  const settled = host.agent.session.snapshotEvents()
  const end = settled.find(event => event.type === 'compaction/end')
  assert.ok(end !== undefined, 'the failure closes the durable bracket exactly once')
  assert.equal(settled.filter(event => event.type === 'compaction/end').length, 1)
  assert.ok(end.data !== undefined && 'error' in end.data, 'the closing marker records the failure')
  assert.equal(userMessages(settled, PROMPT_TEXT).length, 1,
    'the accepted prompt is still delivered exactly once after the failed maintenance')
  assert.equal(turnStarts(settled).length, seedTurns + 1,
    'the parked prompt starts its own turn instead of being lost or replayed')
})

// ── The application (L6) composition over the real TSP runner ───────────────

/** The latest controlled editor text committed for the composer. */
function composerText(fixture: DirectTspFixture): string | undefined {
  const composer = wireNodes(fixture.pane).find(node => node.id === 'dock.composer')
  return typeof composer?.p.text === 'string' ? composer.p.text : undefined
}

/** Type one line into the real composer and press Enter once it is held. */
async function submitInput(fixture: DirectTspFixture, command: string): Promise<void> {
  fixture.pane.input.type(command)
  await waitFor(`the composer to hold ${command}`, () => composerText(fixture) === command)
  fixture.pane.input.type('\r')
}

/** The live Host Agents this surface owns, by Session id (the Host authority). */
function liveAgentIds(fixture: DirectTspFixture): string[] {
  const agents = fixture.ctx.get('agents') as unknown as { list(): readonly { session: { id: string } }[] }
  return agents.list().map(agent => agent.session.id)
}

/** One live Session's authoritative log (the Host store's own read). */
function liveSessionEvents(fixture: DirectTspFixture, sessionId: string): readonly SessionEvent[] {
  const sessions = fixture.ctx.get('sessions') as unknown as {
    get(id: SessionId): { snapshotEvents(): readonly SessionEvent[] } | undefined
  }
  return sessions.get(SessionId(sessionId))?.snapshotEvents() ?? []
}

test('a TSP Enter reaches the real Host during a held official compact, while the command keeps its business lifetime', async (t) => {
  const life = testLifecycle(t)
  const { promise: summaryGate, resolve: releaseSummary } = Promise.withResolvers<void>()
  life.defer(() => releaseSummary())
  const fixture = await createDirectTspFixture(life, { officialCompact: true })
  const compact = fixture.officialCompact
  assert.ok(compact !== undefined, 'the official compaction chain is mounted')
  compact.holdSummary(summaryGate)
  const prompts: Array<{
    readonly sessionId: string
    readonly message: unknown
    readonly mode: string
    readonly outcome: { readonly kind: string }
  }> = []
  const recorder = fixture.recordPrompts(call => { prompts.push(call) })
  life.defer(() => recorder.detach())
  try {
    await waitForInputDelivery(fixture.pane)
    // A real closed turn first: the official manual compaction needs a
    // compactable surface range, and this suite never fabricates one.
    await submitInput(fixture, TUI_SEED_TEXT)
    await waitFor('the seed prompt write to settle', () => recorder.calls() === 1 && prompts.length === 1, 30_000)
    const sessionEvents = (): readonly SessionEvent[] => liveSessionEvents(fixture, prompts[0]!.sessionId)
    await waitFor('the seed turn to close', () => sessionEvents().some(event => event.type === 'turn/end'), 30_000)

    await submitInput(fixture, '/compact')
    await waitFor('the real official compact to reach summarization',
      () => compact.summarizeEntries() === 1, 30_000)
    const duringSummary = sessionEvents()
    assert.ok(duringSummary.some(event => event.type === 'compaction/start'),
      'the official transaction appended its durable opening marker')
    assert.ok(!duringSummary.some(event => event.type === 'command/done'),
      'the compact command still owns its business lifetime')

    // B: a plain Enter submitted while the summary is held. It must reach the
    // real Host (and clear the held composer) BEFORE A settles.
    await submitInput(fixture, PROMPT_TEXT)
    await waitFor('B to be accepted by the real Host while the compact is held',
      () => recorder.calls() === 2 && prompts.length === 2, 30_000)
    assert.ok(JSON.stringify(prompts[1]!.message).includes(PROMPT_TEXT),
      'the settled write carries the submitted prompt')
    assert.equal(prompts[1]!.outcome.kind, 'committed', 'B settled committed')
    assert.equal(prompts[1]!.mode, 'queue', 'an idle-looking maintenance admits a queued prompt')
    assert.equal(composerText(fixture), '', 'B left the held composer at the Host acceptance')
    const held = sessionEvents()
    assert.equal(held.filter(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes(PROMPT_TEXT)).length, 0,
    'the accepted prompt is parked in the Inbox, not consumed during maintenance')
    assert.equal(held.filter(event => event.type === 'turn/start').length, 1,
      'no model turn started while the maintenance is open')
    assert.ok(!held.some(event => event.type === 'command/done'),
      'A is still unsettled while B was accepted: ordering opened, business did not')

    releaseSummary()
    await waitFor('the compact command to reach its real terminal',
      () => sessionEvents().some(event => event.type === 'command/done'), 30_000)
    await waitFor('B to be consumed exactly once after the maintenance',
      () => sessionEvents().filter(event => event.type === 'user/message'
        && JSON.stringify(event.data).includes(PROMPT_TEXT)).length === 1, 30_000)
    await waitFor('B turn to close',
      () => sessionEvents().filter(event => event.type === 'turn/end').length === 2, 30_000)
    const settled = sessionEvents()
    const end = settled.find(event => event.type === 'compaction/end')
    assert.ok(end !== undefined, 'the official compaction bracket closed')
    assert.equal(end.data !== undefined && 'error' in end.data, false,
      'the official compaction succeeded (a failed summary would restore the draft)')
    const done = settled.find(event => event.type === 'command/done')
    assert.equal((done?.data as { kind?: string } | undefined)?.kind, 'success',
      'the official command settled as success')
    const delivered = settled.filter(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes(PROMPT_TEXT))
    assert.equal(delivered.length, 1, 'exactly one durable copy of B')
    assert.ok(delivered[0]!.seq > end.seq, 'B is delivered only after the maintenance bracket closes')
    const starts = settled.filter(event => event.type === 'turn/start')
    assert.equal(starts.length, 2, 'exactly one new model turn ran for B')
    assert.ok(starts.at(-1)!.seq > end.seq, 'B turn starts after the maintenance bracket closes')
    assert.equal(composerText(fixture), '', 'the accepted draft was not restored')
    assert.equal(recorder.calls(), 2, 'no prompt was written twice')
  } finally {
    // Fallback release BEFORE teardown: a failing assertion must not strand the
    // owned command workflow the fixture's disposal waits for.
    releaseSummary()
    recorder.detach()
    await fixture.settle()
  }
})

test('the real /new Session publication waits for the held official compact to settle', async (t) => {
  const life = testLifecycle(t)
  const { promise: summaryGate, resolve: releaseSummary } = Promise.withResolvers<void>()
  life.defer(() => releaseSummary())
  const fixture = await createDirectTspFixture(life, { officialCompact: true })
  const compact = fixture.officialCompact
  assert.ok(compact !== undefined)
  compact.holdSummary(summaryGate)
  const recorder = fixture.recordPrompts(() => {})
  life.defer(() => recorder.detach())
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, TUI_SEED_TEXT)
    await waitFor('the seed prompt write to settle', () => recorder.calls() === 1, 30_000)
    const sessionEvents = (): readonly SessionEvent[] => {
      const id = liveAgentIds(fixture)[0]
      return id === undefined ? [] : liveSessionEvents(fixture, id)
    }
    await waitFor('the seed turn to close',
      () => sessionEvents().some(event => event.type === 'turn/end'), 30_000)
    const before = liveAgentIds(fixture)
    assert.equal(before.length, 1, 'the seed Session owns the one live Agent')

    await submitInput(fixture, '/compact')
    await waitFor('the real official compact to reach summarization',
      () => compact.summarizeEntries() === 1, 30_000)
    await submitInput(fixture, '/new')
    // Bounded observation window: the held official command cannot settle on its
    // own, so the navigation's writer drain / FIFO position is the ONLY gate here.
    await directSettle(800)
    assert.deepEqual(liveAgentIds(fixture), before,
      'the /new Session is not published while the official compact is unsettled')
    assert.ok(!sessionEvents().some(event => event.type === 'command/done'),
      'the official command is still running')

    releaseSummary()
    await waitFor('the /new owner publication after the compact settles',
      () => {
        const ids = liveAgentIds(fixture)
        return ids.length === 1 && ids[0] !== before[0]
      }, 30_000)
  } finally {
    releaseSummary()
    recorder.detach()
    await fixture.settle()
  }
})
