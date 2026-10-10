/**
 * F6 — Transcript display-order & read-grouping convergence (plan
 * `temp/20261010/f6-transcript-display-order-convergence.md` §5).
 *
 * The fold appends rows in DURABLE EVENT ORDER, while the live lane
 * materializes a row when its content first becomes visible. For a step whose
 * first visible assistant text precedes a later tool call of the same step the
 * two folds therefore disagree: live shows `Work[c1] → Assistant → Work[c2]`
 * (two Activities), cold shows `Work[c1, c2] → Assistant` (one), and
 * raw-adjacent settled reads are merged into one `N files` card before any
 * display rule can split them.
 *
 * Stage 1 of the plan is these tests: T1/T2 must FAIL on the current baseline
 * (they are the red witnesses), while T3/T5 pin the conservative behavior that
 * must survive the fix (no over-splitting, no guessing without evidence).
 *
 * Logical identity is compared across the two folds (kind + stable logical key
 * such as the tool callId or the assistant text) — never raw object references,
 * which are only guaranteed stable within one fold.
 * @module @xmoon76/dsh-pi-tui/transcript-display-order-convergence.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder, transcriptTimingOf, type TranscriptMessage } from '../src/transcript.ts'
import { projectTranscriptStructure, type TranscriptWorkSpan } from '../src/tui/transcript/structure.ts'
import { summarizeWorkSpan } from '../src/tui/transcript/work-summary.ts'
import { CompactWorkComponent, formatWorkHeaderLine } from '../src/tui/components/transcript/compact-work.ts'
import { activityClockOf } from '../src/tui/transcript/activity-clock.ts'
import { resolveWorkLifetimes, type WorkLifetime } from '../src/tui/transcript/activity-clock.ts'

const T0 = 1_700_000_000_000

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as unknown as SessionEvent
}

interface ToolCallInput {
  readonly callId: string
  readonly name: string
  readonly turn: number
  readonly step: number
  readonly time: number
  readonly seq: number
  readonly args?: string
}

function toolCall(input: ToolCallInput): SessionEvent {
  return eventAt('tool/call', {
    turn: input.turn, step: input.step, callId: input.callId, name: input.name,
    arguments: input.args ?? '{}',
  }, input.time, input.seq)
}

function toolResult(callId: string, turn: number, step: number, time: number, seq: number, text: string): SessionEvent {
  return eventAt('tool/result', {
    turn, step,
    message: {
      id: `r-${callId}`, role: 'tool', toolCallId: callId,
      content: [{ type: 'text', text }], source: { kind: 'tool', callId },
    },
  }, time, seq)
}

/** One durable assistant settlement whose embedded stream carries the visible
 *  reply text (and optionally a later tool-call delta) at explicit times. */
function assistantSettlement(input: {
  readonly turn: number
  readonly step: number
  readonly time: number
  readonly seq: number
  readonly text: string
  readonly stream: readonly Record<string, unknown>[]
}): SessionEvent {
  return eventAt('assistant/message', {
    turn: input.turn, step: input.step,
    message: {
      id: `m-${input.turn}-${input.step}`, role: 'assistant',
      content: [{ type: 'text', text: input.text }], source: { kind: 'assistant' },
    },
    stream: input.stream,
  }, input.time, input.seq)
}

function textChunk(time: number, index: number, text: string): Record<string, unknown> {
  return { type: 'chunk', time, chunk: { type: 'text-delta', index, text } }
}

function toolCallDeltaChunk(time: number, index: number, id: string, name: string): Record<string, unknown> {
  return { type: 'chunk', time, chunk: { type: 'tool-call-delta', index, id, name, argumentsDelta: '{}' } }
}

function foldEvents(events: readonly SessionEvent[]): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.hydrate(events)
  return folder
}

/** The stable logical identity of one visible row (never an object reference). */
function logicalId(message: TranscriptMessage): string {
  if (message.kind === 'tool') return `tool:${message.callId ?? message.name}`
  if (message.kind === 'assistant') return `assistant:${message.text}`
  if (message.kind === 'thinking') return `thinking:${message.text}`
  if ('text' in message) return `${message.kind}:${message.text}`
  return message.kind
}

function logicalRows(folder: TranscriptFolder): string[] {
  return folder.messages().map(logicalId)
}

function structureKinds(folder: TranscriptFolder): string[] {
  return projectTranscriptStructure(folder.messages()).map(block => block.kind)
}

interface SpanFacts {
  readonly owner: string
  readonly members: readonly string[]
  readonly actions: number
  readonly lifetime: WorkLifetime
}

function spanFacts(folder: TranscriptFolder): SpanFacts[] {
  const structure = projectTranscriptStructure(folder.messages())
  const lifetimes = resolveWorkLifetimes(structure, folder.turnActivities())
  const spans: TranscriptWorkSpan[] = []
  for (const block of structure) {
    if (block.kind === 'work') spans.push(block.span)
  }
  return spans.map(span => ({
    owner: logicalId(span.owner),
    members: span.members.map(logicalId),
    actions: summarizeWorkSpan(span).actionStats.total,
    // Compare the LIFETIME structurally: the span's own members/order drive it,
    // so equal Work partitions must derive equal lifetimes.
    lifetime: lifetimes.get(span.owner)!,
  }))
}

// ── shared fixtures ────────────────────────────────────────────────────────

/** `Tool c1 (step 0) → Assistant text visible at +2s → Tool c2 (step 1) at +3s`. */
function interleavedEvents(): SessionEvent[] {
  return [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall({ callId: 'c1', name: 'bash', turn: 1, step: 0, time: T0 + 1_000, seq: 1 }),
    toolResult('c1', 1, 0, T0 + 1_500, 2, 'a'),
    toolCall({ callId: 'c2', name: 'read', turn: 1, step: 1, time: T0 + 3_000, seq: 3, args: '{"file_path":"b"}' }),
    toolResult('c2', 1, 1, T0 + 4_000, 4, 'b'),
    assistantSettlement({
      turn: 1, step: 1, time: T0 + 5_000, seq: 5, text: 'let me check',
      stream: [
        textChunk(T0 + 2_000, 0, 'let me check'),
        toolCallDeltaChunk(T0 + 3_000, 1, 'c2', 'read'),
      ],
    }),
  ]
}

/** The LIVE equivalent of {@link interleavedEvents}: the assistant row appears
 *  with its first visible text chunk before the step's tool events are folded. */
function interleavedLive(): TranscriptFolder {
  const events = interleavedEvents()
  const folder = new TranscriptFolder()
  folder.hydrate([events[0]!, events[1]!, events[2]!])
  folder.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 1, time: T0 + 2_000,
    chunk: { type: 'text-delta', index: 0, text: 'let me check' },
  })
  folder.apply([events[3]!, events[4]!, events[5]!])
  return folder
}

/** `Read A (step 0) → Assistant text visible at +2s → Read B (step 1) at +3s`. */
function readsAcrossConversationEvents(): SessionEvent[] {
  return [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall({ callId: 'read-a', name: 'read', turn: 1, step: 0, time: T0 + 1_000, seq: 1, args: '{"file_path":"a.ts"}' }),
    toolResult('read-a', 1, 0, T0 + 1_500, 2, 'a'),
    toolCall({ callId: 'read-b', name: 'read', turn: 1, step: 1, time: T0 + 3_000, seq: 3, args: '{"file_path":"b.ts"}' }),
    toolResult('read-b', 1, 1, T0 + 4_000, 4, 'b'),
    assistantSettlement({
      turn: 1, step: 1, time: T0 + 5_000, seq: 5, text: 'between the reads',
      stream: [
        textChunk(T0 + 2_000, 0, 'between the reads'),
        toolCallDeltaChunk(T0 + 3_000, 1, 'read-b', 'read'),
      ],
    }),
  ]
}

// ── T1: the core Work-partition parity ─────────────────────────────────────

test('T1: Tool → Assistant text → Tool derives the SAME live and cold Work partition', () => {
  const cold = foldEvents(interleavedEvents())
  const live = interleavedLive()
  // VISIBLE ROW ORDER (logical identity, never object references).
  assert.deepEqual(logicalRows(cold), logicalRows(live),
    'the visible row order must converge')
  assert.deepEqual(logicalRows(cold), ['tool:c1', 'assistant:let me check', 'tool:c2'],
    'the Conversation sits between the two tools')
  // CANONICAL STRUCTURE: two Work spans separated by the Conversation.
  assert.deepEqual(structureKinds(cold), structureKinds(live),
    'the canonical structure must converge')
  assert.deepEqual(structureKinds(cold), ['work', 'message', 'work'])
  assert.deepEqual(spanFacts(cold), spanFacts(live),
    'owners, members, action counts and lifetimes must converge')
  assert.deepEqual(spanFacts(cold).map(facts => facts.members), [['tool:c1'], ['tool:c2']])
})

// ── T2: reads separated by a Conversation must not merge ───────────────────

test('T2: a Conversation visible between two reads keeps them as two reads in the cold fold too', () => {
  const cold = foldEvents(readsAcrossConversationEvents())
  const reads = cold.messages().filter(message => message.kind === 'tool')
  assert.equal(reads.length, 2, 'cold must not collapse the two reads into one card')
  assert.deepEqual(reads.map(read => read.callCount ?? 1), [1, 1],
    'each read keeps its own genuine call cardinality')
  assert.deepEqual(logicalRows(cold),
    ['tool:read-a', 'assistant:between the reads', 'tool:read-b'])
  assert.deepEqual(cold.messages().map(message => message.kind === 'tool' ? message.args : '').filter(Boolean),
    ['{"file_path":"a.ts"}', '{"file_path":"b.ts"}'],
    'no `2 files` merged card may survive')
  // Each split read keeps its OWN wall span: a split must never leave an
  // aggregate over members that no longer share a card.
  assert.equal(transcriptTimingOf(reads[0]!)?.startedAt, T0 + 1_000)
  assert.equal(transcriptTimingOf(reads[0]!)?.endedAt, T0 + 1_500)
  assert.equal(transcriptTimingOf(reads[1]!)?.startedAt, T0 + 3_000)
  assert.equal(transcriptTimingOf(reads[1]!)?.endedAt, T0 + 4_000)
})

// ── T3: genuinely adjacent reads still merge (no over-splitting) ───────────

test('T3: reads with no Conversation between them still merge', () => {
  // The assistant text is first visible AFTER both reads, so no record proves it
  // belongs between them: the conservative (and correct) result is one group.
  const cold = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall({ callId: 'read-a', name: 'read', turn: 1, step: 0, time: T0 + 1_000, seq: 1, args: '{"file_path":"a.ts"}' }),
    toolResult('read-a', 1, 0, T0 + 1_200, 2, 'a'),
    toolCall({ callId: 'read-b', name: 'read', turn: 1, step: 1, time: T0 + 2_000, seq: 3, args: '{"file_path":"b.ts"}' }),
    toolResult('read-b', 1, 1, T0 + 2_200, 4, 'b'),
    assistantSettlement({
      turn: 1, step: 1, time: T0 + 5_000, seq: 5, text: 'after both reads',
      stream: [textChunk(T0 + 4_000, 0, 'after both reads')],
    }),
  ])
  const reads = cold.messages().filter(message => message.kind === 'tool')
  assert.equal(reads.length, 1, 'the two reads stay one group')
  assert.equal(reads[0]!.callCount, 2, 'both genuine calls count')
  assert.match(reads[0]!.args, /2 files/u)
  assert.deepEqual(logicalRows(cold), ['tool:read-a', 'assistant:after both reads'])
})

// ── T4: mixed Thinking / Assistant / Tool lanes ────────────────────────────

test('T4a: Thinking → Assistant → tools keeps the reasoning lane before the Conversation and the tools after it', () => {
  const stream = [
    { type: 'chunk', time: T0 + 1_000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'chunk', time: T0 + 1_000, chunk: { type: 'reasoning-delta', index: 0, text: 'brief thought' } },
    { type: 'chunk', time: T0 + 1_500, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'brief thought' } } },
    textChunk(T0 + 2_000, 1, 'answer one'),
    toolCallDeltaChunk(T0 + 3_000, 2, 'c9', 'bash'),
  ]
  const events = [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall({ callId: 'c9', name: 'bash', turn: 1, step: 0, time: T0 + 3_000, seq: 1 }),
    toolResult('c9', 1, 0, T0 + 3_500, 2, 'ok'),
    assistantSettlement({ turn: 1, step: 0, time: T0 + 5_000, seq: 3, text: 'answer one', stream }),
  ]
  const cold = foldEvents(events)
  assert.deepEqual(logicalRows(cold), ['thinking:brief thought', 'assistant:answer one', 'tool:c9'],
    'the reasoning lane precedes the Conversation and the tool follows both')
  assert.deepEqual(structureKinds(cold), ['work', 'message', 'work'])
})

test('T4b: an assistant-first lane order keeps the Conversation before its reasoning row', () => {
  const stream = [
    textChunk(T0 + 1_000, 0, 'answer first'),
    { type: 'chunk', time: T0 + 1_500, chunk: { type: 'block-start', index: 1, blockType: 'reasoning' } },
    { type: 'chunk', time: T0 + 1_500, chunk: { type: 'reasoning-delta', index: 1, text: 'later thought' } },
    { type: 'chunk', time: T0 + 2_000, chunk: { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'later thought' } } },
  ]
  const cold = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    assistantSettlement({ turn: 1, step: 0, time: T0 + 5_000, seq: 1, text: 'answer first', stream }),
  ])
  assert.deepEqual(logicalRows(cold), ['assistant:answer first', 'thinking:later thought'],
    'the durable lane authority keeps the assistant row first')
})

// ── T5: negative cases — no guessing without evidence ─────────────────────

test('T5a: tools of a DIFFERENT turn are never displaced by another turn’s Conversation', () => {
  const cold = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall({ callId: 'c1', name: 'bash', turn: 1, step: 0, time: T0 + 1_000, seq: 1 }),
    toolResult('c1', 1, 0, T0 + 1_500, 2, 'a'),
    eventAt('turn/start', { turn: 2 }, T0 + 2_000, 3),
    assistantSettlement({
      turn: 2, step: 0, time: T0 + 5_000, seq: 4, text: 'turn two answer',
      stream: [textChunk(T0 + 2_500, 0, 'turn two answer')],
    }),
    toolCall({ callId: 'c2', name: 'bash', turn: 2, step: 0, time: T0 + 6_000, seq: 5 }),
    toolResult('c2', 2, 0, T0 + 6_500, 6, 'b'),
  ])
  assert.deepEqual(logicalRows(cold),
    ['tool:c1', 'assistant:turn two answer', 'tool:c2'],
    'a cross-turn Conversation never reaches back into the earlier turn')
})

test('T5b: a streamless settlement provides no order evidence, so no tool is displaced', () => {
  const cold = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall({ callId: 'c1', name: 'bash', turn: 1, step: 0, time: T0 + 1_000, seq: 1 }),
    toolResult('c1', 1, 0, T0 + 1_500, 2, 'a'),
    toolCall({ callId: 'c2', name: 'bash', turn: 1, step: 1, time: T0 + 3_000, seq: 3 }),
    toolResult('c2', 1, 1, T0 + 3_500, 4, 'b'),
    // No embedded stream: nothing proves when the reply text became visible.
    eventAt('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'm-streamless', role: 'assistant',
        content: [{ type: 'text', text: 'no stream' }], source: { kind: 'assistant' },
      },
    }, T0 + 5_000, 5),
  ])
  assert.deepEqual(logicalRows(cold), ['tool:c1', 'tool:c2', 'assistant:no stream'],
    'without evidence the durable append order is preserved')
})

test('T5c: an equal-time Conversation provides no provable ORDER, so no tool is displaced', () => {
  const cold = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall({ callId: 'c1', name: 'bash', turn: 1, step: 1, time: T0 + 3_000, seq: 1 }),
    toolResult('c1', 1, 1, T0 + 3_500, 2, 'a'),
    assistantSettlement({
      turn: 1, step: 0, time: T0 + 5_000, seq: 3, text: 'same instant',
      // The first visible text carries exactly the tool's call time: equal
      // timestamps cannot prove either side came first.
      stream: [textChunk(T0 + 3_000, 0, 'same instant')],
    }),
  ])
  assert.deepEqual(logicalRows(cold), ['tool:c1', 'assistant:same instant'],
    'equal times stay in the durable order instead of guessing')
})

test('T5d: a stream tool-call delta whose callId matches no recorded call displaces nothing', () => {
  const cold = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall({ callId: 'c1', name: 'bash', turn: 1, step: 1, time: T0 + 3_000, seq: 1 }),
    toolResult('c1', 1, 1, T0 + 3_500, 2, 'a'),
    assistantSettlement({
      turn: 1, step: 0, time: T0 + 5_000, seq: 3, text: 'before the tool',
      stream: [
        textChunk(T0 + 1_000, 0, 'before the tool'),
        // Identity mismatch: this delta names a call the fold never saw.
        toolCallDeltaChunk(T0 + 1_500, 1, 'unknown-call', 'bash'),
      ],
    }),
  ])
  assert.deepEqual(logicalRows(cold), ['tool:c1', 'assistant:before the tool'],
    'only an identified, recorded call may be reordered')
})

test('T5e: duplicate tool names never cross-talk — displacement follows the callId', () => {
  const cold = foldEvents([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall({ callId: 'bash-a', name: 'bash', turn: 1, step: 0, time: T0 + 1_000, seq: 1 }),
    toolResult('bash-a', 1, 0, T0 + 1_200, 2, 'a'),
    toolCall({ callId: 'bash-b', name: 'bash', turn: 1, step: 1, time: T0 + 3_000, seq: 3 }),
    toolResult('bash-b', 1, 1, T0 + 3_200, 4, 'b'),
    assistantSettlement({
      turn: 1, step: 1, time: T0 + 5_000, seq: 5, text: 'between same-named tools',
      stream: [
        textChunk(T0 + 2_000, 0, 'between same-named tools'),
        toolCallDeltaChunk(T0 + 3_000, 1, 'bash-b', 'bash'),
      ],
    }),
  ])
  assert.deepEqual(logicalRows(cold),
    ['tool:bash-a', 'assistant:between same-named tools', 'tool:bash-b'],
    'only the call named by the evidence moves')
})

// ── T2b: the split reads keep their own corpus, representative and window slot ──

test('T2b: each split read keeps its own search corpus, representative and window slot', () => {
  const cold = foldEvents(readsAcrossConversationEvents())
  const readA = cold.search('a.ts')
  const readB = cold.search('b.ts')
  assert.equal(readA.length, 1)
  assert.equal(readB.length, 1)
  assert.notEqual(readA[0]!.id, readB[0]!.id, 'each read resolves to its OWN card')
  const cardA = cold.resolveSearchMatch(readA[0]!)
  const cardB = cold.resolveSearchMatch(readB[0]!)
  assert.ok(cardA !== undefined && cardA.kind === 'tool')
  assert.ok(cardB !== undefined && cardB.kind === 'tool')
  assert.match(cardA.args, /a\.ts/u, 'the a.ts hit never lands on the b.ts card')
  assert.match(cardB.args, /b\.ts/u)
  assert.equal(cardA.callCount, 1)
  assert.equal(cardB.callCount, 1)
  const windowed = cold.window({ maxTurns: 1 })
  assert.deepEqual(windowed.messages.map(logicalId), cold.messages().map(logicalId),
    'the bounded window agrees with the full projection')
  assert.deepEqual(windowed.messages.filter(message => message.kind === 'tool').map(message => message.args),
    ['{"file_path":"a.ts"}', '{"file_path":"b.ts"}'])
})

// ── T4c: a second step's lane after a tool row ─────────────────────────────

test('T4c: each step keeps its own lane order; only the provable part is reordered', () => {
  const events = [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall({ callId: 'c9', name: 'bash', turn: 1, step: 0, time: T0 + 3_000, seq: 1 }),
    toolResult('c9', 1, 0, T0 + 3_500, 2, 'ok'),
    assistantSettlement({
      turn: 1, step: 0, time: T0 + 5_000, seq: 3, text: 'step zero',
      stream: [
        { type: 'chunk', time: T0 + 1_000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', time: T0 + 1_000, chunk: { type: 'reasoning-delta', index: 0, text: 'first thought' } },
        { type: 'chunk', time: T0 + 1_500, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'first thought' } } },
        textChunk(T0 + 2_000, 1, 'step zero'),
        toolCallDeltaChunk(T0 + 3_000, 2, 'c9', 'bash'),
      ],
    }),
    assistantSettlement({
      turn: 1, step: 1, time: T0 + 9_000, seq: 4, text: 'step one',
      stream: [
        { type: 'chunk', time: T0 + 6_000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', time: T0 + 6_000, chunk: { type: 'reasoning-delta', index: 0, text: 'second thought' } },
        { type: 'chunk', time: T0 + 6_500, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'second thought' } } },
        textChunk(T0 + 7_000, 1, 'step one'),
      ],
    }),
  ]
  const cold = foldEvents(events)
  // Step 0's reasoning precedes its Conversation (lane authority), its Tool is
  // displaced after that Conversation (its own call time), and step 1 keeps the
  // durable order — the cross-step relation has no evidence and is never guessed.
  assert.deepEqual(logicalRows(cold), [
    'thinking:first thought', 'assistant:step zero', 'tool:c9', 'thinking:second thought', 'assistant:step one',
  ])
  // The Work membership follows that display order: step 0's reasoning is its own
  // Activity, and the adjacent tool + step-1 reasoning share the next one.
  assert.deepEqual(structureKinds(cold), ['work', 'message', 'work', 'message'])
})

// ── T6: Preparing start before the visible text, durable call after ────────

test('T6: a Tool whose LIVE materialization preceded the visible text stays before the Conversation', () => {
  const events = (): SessionEvent[] => [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    assistantSettlement({
      turn: 1, step: 0, time: T0 + 6_000, seq: 1, text: 'text at two',
      stream: [
        // The call was PREPARING (its earliest materialization evidence) at +1s,
        // while the reply text only became visible at +2s.
        toolCallDeltaChunk(T0 + 1_000, 0, 'c1', 'bash'),
        textChunk(T0 + 2_000, 1, 'text at two'),
      ],
    }),
    toolCall({ callId: 'c1', name: 'bash', turn: 1, step: 0, time: T0 + 3_000, seq: 2 }),
    toolResult('c1', 1, 0, T0 + 4_000, 3, 'ok'),
  ]
  const cold = foldEvents(events())
  const live = new TranscriptFolder()
  live.hydrate([events()[0]!])
  live.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 1_000,
    chunk: { type: 'tool-call-delta', index: 0, id: 'c1', name: 'bash', argumentsDelta: '{}' },
  })
  live.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 2_000,
    chunk: { type: 'text-delta', index: 1, text: 'text at two' },
  })
  live.apply([events()[1]!, events()[2]!, events()[3]!])
  // The card's earliest evidence (+1s) is what the user saw first, so the Tool
  // belongs BEFORE the Conversation in both folds — never forced after it by the
  // durable call time alone.
  assert.deepEqual(logicalRows(cold), ['tool:c1', 'assistant:text at two'])
  assert.deepEqual(logicalRows(live), logicalRows(cold))
  assert.deepEqual(structureKinds(cold), ['work', 'message'])
})

// ── T7: display-order invariants under displacement and re-application ─────

test('T7: a displaced fold emits every visible row once with stable ids, and re-application is inert', () => {
  // Distinctive result text: a merged read card keeps its MEMBERS' evidence but
  // the representative's corpus is the group text, so a hit is looked up by the
  // content that survives the merge.
  const events = (): SessionEvent[] => [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall({ callId: 'read-a', name: 'read', turn: 1, step: 0, time: T0 + 1_000, seq: 1, args: '{"file_path":"a.ts"}' }),
    toolResult('read-a', 1, 0, T0 + 1_200, 2, 'alpha-content'),
    toolCall({ callId: 'read-b', name: 'read', turn: 1, step: 1, time: T0 + 3_000, seq: 3, args: '{"file_path":"b.ts"}' }),
    toolResult('read-b', 1, 1, T0 + 3_200, 4, 'beta-content'),
    assistantSettlement({
      turn: 1, step: 1, time: T0 + 5_000, seq: 5, text: 'between the reads',
      stream: [textChunk(T0 + 2_000, 0, 'between the reads'), toolCallDeltaChunk(T0 + 3_000, 1, 'read-b', 'read')],
    }),
  ]
  const folder = foldEvents(events())
  const rows = logicalRows(folder)
  assert.equal(new Set(rows).size, rows.length, 'no visible row is emitted twice')
  assert.deepEqual(rows, ['tool:read-a', 'assistant:between the reads', 'tool:read-b'])
  const hitBefore = folder.search('alpha-content')
  assert.equal(hitBefore.length, 1)
  assert.equal(folder.search('beta-content').length, 1, 'each split read keeps its own hit')
  assert.notEqual(folder.search('beta-content')[0]!.id, hitBefore[0]!.id)
  // A turn-bounded slice never strands a displaced row: the anchor and its
  // displaced rows share one turn, so the complete-turn window covers them.
  const anchored = folder.window({ maxTurns: 1, endTurn: 1 })
  assert.deepEqual(anchored.messages.map(logicalId), rows)
  // Re-applying the settlement is inert: the relations are already recorded.
  folder.apply([events()[5]!])
  assert.deepEqual(logicalRows(folder), rows)
  assert.deepEqual(structureKinds(folder), ['work', 'message', 'work'])
  assert.equal(folder.search('alpha-content')[0]?.id, hitBefore[0]!.id,
    'the raw TranscriptItemId is stable across the displacement and re-application')
})

// ── T8: the real consumer chain down to the Compact presentation ───────────

test('T8: the converged Work partition reaches the Compact presentation as two Activities', () => {
  const cold = foldEvents(interleavedEvents())
  const spans: TranscriptWorkSpan[] = []
  for (const block of projectTranscriptStructure(cold.messages())) {
    if (block.kind === 'work') spans.push(block.span)
  }
  assert.equal(spans.length, 2)
  const headers = spans.map(span => {
    const summary = summarizeWorkSpan(span)
    return formatWorkHeaderLine(summary, false, 120, 'emoji', undefined)
  })
  assert.match(headers[0]!, /1 action · bash ×1/u,
    `the first Activity owns only its own tool:\n${headers[0]}`)
  assert.match(headers[1]!, /1 action · read ×1/u,
    `the second Activity owns only its own tool:\n${headers[1]}`)
  assert.ok(!headers.some(header => /2 actions/u.test(header)),
    'no Activity may absorb the other step’s tool (the merged cold card is gone)')
})

// ── helpers for the finding regressions ────────────────────────────────────

const turnStart = (turn: number, time: number, seq: number): SessionEvent =>
  eventAt('turn/start', { turn }, time, seq)

function readCall(callId: string, turn: number, step: number, time: number, seq: number, file: string): SessionEvent {
  return toolCall({ callId, name: 'read', turn, step, time, seq, args: `{"file_path":"${file}"}` })
}

type ToolRow = Extract<TranscriptMessage, { kind: 'tool' }>

function toolRows(folder: TranscriptFolder): ToolRow[] {
  return folder.messages().filter((message): message is ToolRow => message.kind === 'tool')
}

// ── F1: the first read of a NEW turn starts its own run ────────────────────

test('F1: reads of a new turn start their own run after a turn transition', () => {
  const cold = foldEvents([
    turnStart(1, T0, 0),
    readCall('a', 1, 0, T0 + 100, 1, 'a.ts'), toolResult('a', 1, 0, T0 + 150, 2, 'a'),
    turnStart(2, T0 + 200, 3),
    readCall('b', 2, 0, T0 + 300, 4, 'b.ts'), toolResult('b', 2, 0, T0 + 350, 5, 'b'),
    readCall('c', 2, 1, T0 + 400, 6, 'c.ts'), toolResult('c', 2, 1, T0 + 450, 7, 'c'),
  ])
  assert.deepEqual(toolRows(cold).map(row => row.args), ['{"file_path":"a.ts"}', '2 files'],
    'turn 1 stays a singleton and turn 2’s reads form their OWN run')
  assert.deepEqual(toolRows(cold).map(row => row.callCount), [1, 2])
})

// ── F2/T6b: the durable call arrived BEFORE the settlement ────────────────

test('T6b: a durable call that arrived BEFORE the settlement honours its Preparing evidence', () => {
  const cold = foldEvents([
    turnStart(1, T0, 0),
    toolCall({ callId: 'c1', name: 'bash', turn: 1, step: 0, time: T0 + 3_000, seq: 1 }),
    toolResult('c1', 1, 0, T0 + 4_000, 2, 'ok'),
    assistantSettlement({
      turn: 1, step: 0, time: T0 + 6_000, seq: 3, text: 'text at two',
      stream: [toolCallDeltaChunk(T0 + 1_000, 0, 'c1', 'bash'), textChunk(T0 + 2_000, 1, 'text at two')],
    }),
  ])
  assert.equal(transcriptTimingOf(toolRows(cold)[0]!)?.startedAt, T0 + 1_000,
    'the card keeps its earliest authoritative evidence, not the durable call time')
  assert.deepEqual(logicalRows(cold), ['tool:c1', 'assistant:text at two'])
})

// ── F3: identity is (turn, step, callId), never the bare call id ──────────

test('F3: a call id reused by another step never moves the newer card', () => {
  const cold = foldEvents([
    turnStart(1, T0, 0),
    toolCall({ callId: 'x', name: 'bash', turn: 1, step: 0, time: T0 + 1_000, seq: 1 }),
    toolResult('x', 1, 0, T0 + 1_500, 2, 'bash ok'),
    readCall('x', 1, 1, T0 + 3_000, 3, 'x.ts'), toolResult('x', 1, 1, T0 + 3_500, 4, 'read ok'),
    assistantSettlement({
      turn: 1, step: 0, time: T0 + 5_000, seq: 5, text: 'step zero',
      stream: [textChunk(T0 + 2_000, 0, 'step zero'), toolCallDeltaChunk(T0 + 2_500, 1, 'x', 'bash')],
    }),
  ])
  assert.deepEqual(cold.messages().map(message => message.kind), ['tool', 'tool', 'assistant'],
    'only the step-0 bash card is the candidate; the step-1 read keeps the durable order')
  assert.deepEqual(toolRows(cold).map(row => row.args), ['{}', '{"file_path":"x.ts"}'])
})

// ── F4: late rows of an earlier turn are not outside their own run ────────

test('F4: late reads of an earlier turn still group with each other (live incremental regroup)', () => {
  // INCREMENTAL (never hydrated): the late turn-1 rows settle through the live
  // regroup path, which is where the positional turn range used to be wrong.
  const live = new TranscriptFolder()
  live.apply([
    turnStart(1, T0, 0),
    readCall('a', 1, 0, T0 + 100, 1, 'a.ts'), toolResult('a', 1, 0, T0 + 150, 2, 'a'),
    turnStart(2, T0 + 200, 3),
    readCall('b', 2, 0, T0 + 300, 4, 'b.ts'), toolResult('b', 2, 0, T0 + 350, 5, 'b'),
    // A late replay appends turn 1's rows AFTER turn 2 already materialized.
    readCall('c', 1, 1, T0 + 3_000, 6, 'c.ts'),
    readCall('d', 1, 2, T0 + 3_100, 7, 'd.ts'),
  ])
  const cold = foldEvents([
    turnStart(1, T0, 0),
    readCall('a', 1, 0, T0 + 100, 1, 'a.ts'), toolResult('a', 1, 0, T0 + 150, 2, 'a'),
    turnStart(2, T0 + 200, 3),
    readCall('b', 2, 0, T0 + 300, 4, 'b.ts'), toolResult('b', 2, 0, T0 + 350, 5, 'b'),
    // A late replay appends turn 1's rows AFTER turn 2 already materialized.
    readCall('c', 1, 1, T0 + 3_000, 6, 'c.ts'),
    readCall('d', 1, 2, T0 + 3_100, 7, 'd.ts'),
    assistantSettlement({
      turn: 2, step: 0, time: T0 + 9_000, seq: 8, text: 'turn two answer',
      stream: [textChunk(T0 + 8_000, 0, 'turn two answer')],
    }),
    toolResult('c', 1, 1, T0 + 3_200, 9, 'c'),
    toolResult('d', 1, 2, T0 + 3_300, 10, 'd'),
  ])
  live.apply([
    assistantSettlement({
      turn: 2, step: 0, time: T0 + 9_000, seq: 8, text: 'turn two answer',
      stream: [textChunk(T0 + 8_000, 0, 'turn two answer')],
    }),
    toolResult('c', 1, 1, T0 + 3_200, 9, 'c'),
    toolResult('d', 1, 2, T0 + 3_300, 10, 'd'),
  ])
  const expected = ['{"file_path":"a.ts"}', '{"file_path":"b.ts"}', '2 files']
  assert.deepEqual(toolRows(live).map(row => row.args), expected,
    'the late turn-1 reads merge with EACH OTHER (turn 2 separates them from a)')
  assert.deepEqual(toolRows(cold).map(row => row.args), expected,
    'and the cold fold derives the same partition')
  assert.deepEqual(logicalRows(live), logicalRows(cold))
})

// ── F5: visibility is display adjacency ───────────────────────────────────

test('F5: hiding the lane row between two reads lets them merge', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    turnStart(1, T0, 0),
    readCall('a', 1, 0, T0 + 100, 1, 'a.ts'), toolResult('a', 1, 0, T0 + 150, 2, 'a'),
  ])
  // A live reasoning row materializes BETWEEN the two reads.
  folder.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 200,
    chunk: { type: 'reasoning-delta', index: 0, text: 'a visible thought' },
  })
  folder.apply([
    readCall('b', 1, 1, T0 + 300, 3, 'b.ts'), toolResult('b', 1, 1, T0 + 350, 4, 'b'),
  ])
  assert.deepEqual(logicalRows(folder), ['tool:a', 'thinking:a visible thought', 'tool:b'],
    'the visible lane row separates the reads')
  // The retry tombstone hides that row: it stops being a boundary.
  folder.apply([eventAt('llm/retry', {
    turn: 1, step: 0, retry: 1, delayMs: 1_000, failure: { code: 'X', message: 'x' },
  }, T0 + 400, 5)])
  const reads = toolRows(folder)
  assert.equal(reads.length, 1, 'the two reads are now visibly adjacent')
  assert.equal(reads[0]!.callCount, 2)
  assert.match(reads[0]!.args, /2 files/u)
})

// ── T4d: an assistant-first lane with a later Tool ───────────────────────

test('T4d: an assistant-first lane with a later Tool converges in both folds', () => {
  const events = (): SessionEvent[] => [
    turnStart(1, T0, 0),
    toolCall({ callId: 'c1', name: 'bash', turn: 1, step: 0, time: T0 + 2_000, seq: 1 }),
    toolResult('c1', 1, 0, T0 + 2_500, 2, 'ok'),
    assistantSettlement({
      turn: 1, step: 0, time: T0 + 9_000, seq: 3, text: 'answer first',
      stream: [
        textChunk(T0 + 1_000, 0, 'answer first'),
        { type: 'chunk', time: T0 + 1_500, chunk: { type: 'block-start', index: 1, blockType: 'reasoning' } },
        { type: 'chunk', time: T0 + 1_500, chunk: { type: 'reasoning-delta', index: 1, text: 'later thought' } },
        { type: 'chunk', time: T0 + 1_800, chunk: { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'later thought' } } },
        toolCallDeltaChunk(T0 + 2_000, 2, 'c1', 'bash'),
      ],
    }),
  ]
  const cold = foldEvents(events())
  const live = new TranscriptFolder()
  live.hydrate([events()[0]!])
  live.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 1_000,
    chunk: { type: 'text-delta', index: 0, text: 'answer first' },
  })
  live.applyLiveInput({
    kind: 'chunk', sessionId: 's', attemptId: 'a', turn: 1, step: 0, time: T0 + 1_500,
    chunk: { type: 'reasoning-delta', index: 1, text: 'later thought' },
  })
  live.apply([events()[1]!, events()[2]!, events()[3]!])
  assert.deepEqual(logicalRows(cold), ['assistant:answer first', 'thinking:later thought', 'tool:c1'],
    'the displaced rows are ordered by their own materialization evidence, not by raw index')
  assert.deepEqual(logicalRows(live), logicalRows(cold))
})

// ── T5f/T5g: one symmetric evidence rule ─────────────────────────────────

test('T5f: a same-step call known only from the durable message block is still converged', () => {
  // The settlement arrives FIRST (creating the Conversation row) and the durable
  // call lands LATER with an EARLIER time: the correct order (Tool before the
  // Conversation) therefore REQUIRES a displacement, and the call is named only
  // by the durable message block — never by a streamed delta.
  const cold = foldEvents([
    turnStart(1, T0, 0),
    eventAt('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: 'm-block', role: 'assistant',
        content: [
          { type: 'text', text: 'text at two' },
          { type: 'tool-call', id: 'a1', name: 'bash', arguments: '{}' },
        ],
        source: { kind: 'assistant' },
      },
      // The stream carries ONLY the visible text: the call is proven by the
      // durable block, which must still be a convergence candidate.
      stream: [textChunk(T0 + 2_000, 0, 'text at two')],
    }, T0 + 6_000, 1),
    toolCall({ callId: 'a1', name: 'bash', turn: 1, step: 0, time: T0 + 1_000, seq: 2 }),
    toolResult('a1', 1, 0, T0 + 1_500, 3, 'ok'),
  ])
  assert.deepEqual(logicalRows(cold), ['tool:a1', 'assistant:text at two'])
})

test('T5g: a streamless settlement provides no ORDER evidence — the durable order is kept', () => {
  const cold = foldEvents([
    turnStart(1, T0, 0),
    eventAt('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: 'm-streamless-2', role: 'assistant',
        content: [{ type: 'text', text: 'no stream at all' }], source: { kind: 'assistant' },
      },
    }, T0 + 6_000, 1),
    // An out-of-order durable call whose event time is EARLIER than the
    // settlement: without a stream this proves nothing about visibility order.
    toolCall({ callId: 'c9', name: 'bash', turn: 1, step: 0, time: T0 + 3_000, seq: 2 }),
    toolResult('c9', 1, 0, T0 + 4_000, 3, 'ok'),
  ])
  assert.deepEqual(logicalRows(cold), ['assistant:no stream at all', 'tool:c9'])
})

// ── strengthened negatives (the guard must actually be reached) ───────────

test('T5c: an equal-time same-step Conversation never reorders the Tool', () => {
  const cold = foldEvents([
    turnStart(1, T0, 0),
    assistantSettlement({
      turn: 1, step: 0, time: T0 + 6_000, seq: 1, text: 'same instant',
      stream: [textChunk(T0 + 3_000, 0, 'same instant'), toolCallDeltaChunk(T0 + 3_000, 1, 'c1', 'bash')],
    }),
    toolCall({ callId: 'c1', name: 'bash', turn: 1, step: 0, time: T0 + 3_000, seq: 2 }),
    toolResult('c1', 1, 0, T0 + 4_000, 3, 'ok'),
  ])
  assert.deepEqual(logicalRows(cold), ['assistant:same instant', 'tool:c1'],
    'a same-step call named by the stream with an EQUAL instant proves no order')
})

test('T5h: a call id reused in another turn is never this step’s candidate', () => {
  // The foreign (turn 2) card exists BEFORE turn 1's settlement runs, so a
  // call-id-keyed lookup would find it and displace it around turn 1's
  // Conversation; the durable (turn, step, callId) identity cannot.
  const cold = foldEvents([
    turnStart(1, T0, 0),
    turnStart(2, T0 + 900, 1),
    toolCall({ callId: 'shared', name: 'bash', turn: 2, step: 0, time: T0 + 4_000, seq: 2 }),
    toolResult('shared', 2, 0, T0 + 4_500, 3, 'ok'),
    // Turn 1's reply only became visible at +2s, i.e. BEFORE turn 2's call time:
    // a bare-call-id lookup would move turn 2's card around it.
    assistantSettlement({
      turn: 1, step: 0, time: T0 + 6_000, seq: 4, text: 'turn one',
      stream: [textChunk(T0 + 2_000, 0, 'turn one'), toolCallDeltaChunk(T0 + 2_500, 1, 'shared', 'bash')],
    }),
  ])
  // The turn-2 card was appended BEFORE turn 1's Conversation, so the durable
  // order is [Tool, Conversation]. A call-id-keyed lookup would resolve THIS
  // card (start +4s > the visible +2s) and displace it AFTER the Conversation;
  // the durable identity finds no candidate for turn 1 at all.
  assert.deepEqual(logicalRows(cold), ['tool:shared', 'assistant:turn one'],
    'the turn-2 card is not this step’s evidence and keeps the durable order')
})

// ── PERF: a live settlement re-groups a LOCAL span, never the whole turn ──

test('PERF: a long turn settles each read in bounded local work', () => {
  const folder = new TranscriptFolder()
  folder.apply([turnStart(1, T0, 0)])
  let seq = 1
  const steps = 120
  let maxSpan = 0
  for (let step = 0; step < steps; step += 1) {
    folder.apply([toolCall({ callId: `c${step}`, name: 'read', turn: 1, step, time: T0 + step * 10, seq: seq++ })])
    const beforeReadSettle = folder.searchDiagnosticsForTest().lastRegroupSpanRows
    folder.apply([toolResult(`c${step}`, 1, step, T0 + step * 10 + 5, seq++, `content ${step}`)])
    assert.equal(folder.searchDiagnosticsForTest().lastRegroupSpanRows, beforeReadSettle,
      'a NORMAL tail settlement stays on the fast path (no local regroup at all)')
    folder.apply([assistantSettlement({
      turn: 1, step, time: T0 + step * 10 + 9, seq: seq++, text: `answer ${step}`,
      stream: [textChunk(T0 + step * 10 + 1, 0, `answer ${step}`), toolCallDeltaChunk(T0 + step * 10 + 4, 1, `c${step}`, 'read')],
    })])
    maxSpan = Math.max(maxSpan, folder.searchDiagnosticsForTest().lastRegroupSpanRows)
  }
  assert.equal(toolRows(folder).length, steps, 'each read is separated by its own Conversation here')
  assert.ok(maxSpan <= 32,
    `a display-order change must re-group a LOCAL span, never the whole turn (max span rows: ${maxSpan})`)
})

// ── the resolved Activity lifetime threads into the Compact presentation ────

test('T8b: the resolved Activity lifetime renders the Compact duration (full consumer chain)', async () => {
  const cold = foldEvents(interleavedEvents())
  const structure = projectTranscriptStructure(cold.messages())
  const spans: TranscriptWorkSpan[] = []
  for (const block of structure) {
    if (block.kind === 'work') spans.push(block.span)
  }
  const lifetimes = resolveWorkLifetimes(structure, cold.turnActivities())
  const span = spans[0]!
  const lifetime = lifetimes.get(span.owner)
  assert.deepEqual(lifetime, { startedAt: T0 + 1_000, endedAt: T0 + 2_000, open: false, trailing: false })
  const clock = activityClockOf(lifetime!, () => false, () => false)
  const component = new CompactWorkComponent({
    span,
    expanded: false,
    action: { kind: 'tool', display: 'Bash x', rootName: 'bash' },
    now: () => T0 + 999_999,
    clock,
  })
  const line = (component.render(120)[0] ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(line, /Activity 1s/u, `the frozen lifetime reaches the rendered header:\n${line}`)
  assert.ok(!/Activity 997s/u.test(line), 'the old open-ended member span must not survive the convergence')
})

// ── several Tool relations on ONE anchor, re-derived on replacement ─────────

test('T9: one anchor owns several Tool relations and re-derives them on a replacement', () => {
  const replacement = (visibleAt: number, seq: number): SessionEvent => eventAt('assistant/message', {
    turn: 1, step: 0,
    message: {
      id: 'm9', role: 'assistant',
      content: [{ type: 'text', text: 'step answer' }], source: { kind: 'assistant' },
    },
    stream: [
      textChunk(visibleAt, 0, 'step answer'),
      toolCallDeltaChunk(T0 + 1_000, 1, 't1', 'bash'),
      toolCallDeltaChunk(T0 + 4_000, 2, 't2', 'read'),
    ],
  }, T0 + 9_000, seq)

  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(1, T0, 0),
    toolCall({ callId: 't1', name: 'bash', turn: 1, step: 0, time: T0 + 1_000, seq: 1 }),
    toolResult('t1', 1, 0, T0 + 1_500, 2, 't1 ok'),
    toolCall({ callId: 't2', name: 'read', turn: 1, step: 0, time: T0 + 4_000, seq: 3, args: '{"file_path":"t2.ts"}' }),
    toolResult('t2', 1, 0, T0 + 4_500, 4, 't2 ok'),
  ])
  // The reply became visible at +2s: t1 (started +1s) stays before it, t2
  // (started +4s) follows it.
  folder.apply([replacement(T0 + 2_000, 5)])
  assert.deepEqual(logicalRows(folder), ['tool:t1', 'assistant:step answer', 'tool:t2'])
  // A same-step replacement proves the reply was only visible at +5s: BOTH tools
  // started before it, so the stale t2 relation must be DROPPED (not inherited).
  folder.apply([replacement(T0 + 5_000, 6)])
  assert.deepEqual(logicalRows(folder), ['tool:t1', 'tool:t2', 'assistant:step answer'],
    'every settlement re-derives the relations it anchors')
  assert.deepEqual(structureKinds(folder), ['work', 'message'])
})

// ── N1: a re-sorted side must re-order the derived read-group members ───────

test('N1: re-sorting one side rebuilds the merged group member order, representative and result', () => {
  const settlement = (bStart: number, seq: number): SessionEvent => eventAt('assistant/message', {
    turn: 1, step: 0,
    message: {
      id: 'm-n1', role: 'assistant',
      content: [{ type: 'text', text: 'reply' }], source: { kind: 'assistant' },
    },
    stream: [
      textChunk(T0 + 2_000, 0, 'reply'),
      toolCallDeltaChunk(T0 + 3_000, 1, 'read-a', 'read'),
      toolCallDeltaChunk(bStart, 2, 'read-b', 'read'),
    ],
  }, T0 + 9_000, seq)

  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(1, T0, 0),
    readCall('read-a', 1, 0, T0 + 3_000, 1, 'a.ts'), toolResult('read-a', 1, 0, T0 + 3_500, 2, 'alpha result'),
    readCall('read-b', 1, 0, T0 + 4_000, 3, 'b.ts'), toolResult('read-b', 1, 0, T0 + 4_500, 4, 'bravo result'),
  ])
  // Reply visible at +2s: BOTH reads follow it, A(+3s) before B(+4s).
  folder.apply([settlement(T0 + 4_000, 5)])
  let merged = toolRows(folder)
  assert.equal(merged.length, 1, 'the two displaced reads share one merged card')
  assert.equal(merged[0]!.callId, 'read-a')
  assert.equal(merged[0]!.result, 'alpha result\n\nbravo result')
  // A same-step replacement proves B materialized EARLIER than A (+2.5s): the
  // side re-sorts, so the group itself must follow the new display order.
  folder.apply([settlement(T0 + 2_500, 6)])
  assert.deepEqual(logicalRows(folder), ['assistant:reply', 'tool:read-b'],
    'the merged card is now emitted at its first DISPLAY member')
  merged = toolRows(folder)
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.callId, 'read-b', 'the representative follows the display order')
  assert.equal(merged[0]!.result, 'bravo result\n\nalpha result',
    'the aggregated result follows the display order')
  assert.match(merged[0]!.args, /2 files/u)
  assert.equal(transcriptTimingOf(merged[0]!)?.startedAt, T0 + 2_500)
})

// ── N2: the regroup envelope closes over its own interior ───────────────────

test('N2: a settlement whose envelope contains an earlier anchor never orphans that anchor’s group', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(1, T0, 0),
    readCall('a', 1, 0, T0 + 1_000, 1, 'a.ts'), toolResult('a', 1, 0, T0 + 1_500, 2, 'alpha'),
    readCall('b', 1, 0, T0 + 2_000, 3, 'b.ts'), toolResult('b', 1, 0, T0 + 2_500, 4, 'bravo'),
    toolCall({ callId: 'd', name: 'read', turn: 1, step: 1, time: T0 + 3_000, seq: 5 }),
    toolCall({ callId: 'e', name: 'read', turn: 1, step: 2, time: T0 + 4_000, seq: 6 }),
    // Step 0's reply was visible at +0.5s: A and B follow it and merge.
    assistantSettlement({
      turn: 1, step: 0, time: T0 + 9_000, seq: 7, text: 'reply zero',
      stream: [
        textChunk(T0 + 500, 0, 'reply zero'),
        toolCallDeltaChunk(T0 + 1_000, 1, 'a', 'read'),
        toolCallDeltaChunk(T0 + 2_000, 2, 'b', 'read'),
      ],
    }),
    toolCall({ callId: 'c', name: 'bash', turn: 1, step: 3, time: T0 + 6_000, seq: 8 }),
    // Step 2's reply was visible at +3.5s: E follows it. The regroup envelope now
    // CONTAINS step 0's anchor while A/B sit outside the raw range.
    assistantSettlement({
      turn: 1, step: 2, time: T0 + 9_100, seq: 9, text: 'reply two',
      stream: [textChunk(T0 + 3_500, 0, 'reply two'), toolCallDeltaChunk(T0 + 4_000, 1, 'e', 'read')],
    }),
  ])
  const rows = toolRows(folder)
  assert.equal(rows.length, 4, 'D, the merged A+B card, C and E are four output cards')
  const mergedCard = rows.filter(row => row.args === '2 files')
  assert.equal(mergedCard.length, 1, 'exactly ONE merged card exists (no orphaned duplicate group)')
  // The window summary counts the same output cards the projection emits.
  folder.apply([
    turnStart(2, T0 + 20_000, 10),
    eventAt('user/message', {
      id: 'u2', role: 'user', content: [{ type: 'text', text: 'later turn' }], source: { kind: 'user' },
    }, T0 + 20_100, 11),
  ])
  const summary = folder.window({ maxTurns: 1 }).messages[0]
  assert.ok(summary !== undefined && summary.kind === 'summary')
  assert.match(summary.text, /4 tool calls/u,
    `the earlier turn's summary must count the four emitted cards:\n${summary.text}`)
})

// ── N3: a replacement drops the call's eligibility for a LATER durable call ──

test('N3: a replacement that stops naming a call removes its eligibility for a later durable call', () => {
  const settlement = (stream: readonly Record<string, unknown>[], seq: number): SessionEvent => eventAt('assistant/message', {
    turn: 1, step: 0,
    message: {
      id: 'm-n3', role: 'assistant',
      content: [{ type: 'text', text: 'reply' }], source: { kind: 'assistant' },
    },
    stream,
  }, T0 + 6_000, seq)
  const folder = new TranscriptFolder()
  folder.apply([turnStart(1, T0, 0)])
  // The first settlement names A (reply visible at +2s, A preparing at +1s).
  folder.apply([settlement([textChunk(T0 + 2_000, 0, 'reply'), toolCallDeltaChunk(T0 + 1_000, 1, 'a', 'bash')], 1)])
  // The authoritative replacement drops A entirely.
  folder.apply([settlement([textChunk(T0 + 2_000, 0, 'reply')], 2)])
  // A's durable call now arrives: with no current candidate it must NOT be
  // displaced before the Conversation.
  folder.apply([
    toolCall({ callId: 'a', name: 'bash', turn: 1, step: 0, time: T0 + 3_000, seq: 3 }),
    toolResult('a', 1, 0, T0 + 3_500, 4, 'ok'),
  ])
  assert.deepEqual(logicalRows(folder), ['assistant:reply', 'tool:a'],
    'the replacement removed the call from this step’s candidates')
})

test('N3b: two steps that request the same call id each keep their own eligibility', () => {
  const folder = new TranscriptFolder()
  const blockSettlement = (
    step: number,
    visibleAt: number,
    seq: number,
    args: string,
  ): SessionEvent => eventAt('assistant/message', {
    turn: 1, step,
    message: {
      id: `m-shared-${step}`, role: 'assistant',
      content: [
        { type: 'text', text: `reply ${step}` },
        { type: 'tool-call', id: 'shared', name: 'bash', arguments: args },
      ],
      source: { kind: 'assistant' },
    },
    stream: [textChunk(visibleAt, 0, `reply ${step}`)],
  }, T0 + 9_000 + step, seq)
  folder.apply([turnStart(1, T0, 0)])
  folder.apply([blockSettlement(0, T0 + 2_000, 1, '{"step":0}')])
  folder.apply([blockSettlement(1, T0 + 4_000, 2, '{"step":1}')])
  // Both durable calls arrive after BOTH settlements: each is owned by its own
  // step's block and must converge before its own Conversation.
  folder.apply([
    toolCall({ callId: 'shared', name: 'bash', turn: 1, step: 0, time: T0 + 1_000, seq: 3, args: '{"step":0}' }),
    toolResult('shared', 1, 0, T0 + 1_500, 4, 'zero'),
    toolCall({ callId: 'shared', name: 'bash', turn: 1, step: 1, time: T0 + 3_000, seq: 5, args: '{"step":1}' }),
    toolResult('shared', 1, 1, T0 + 3_500, 6, 'one'),
  ])
  assert.deepEqual(folder.messages().map(message => message.kind),
    ['tool', 'assistant', 'tool', 'assistant'],
    'each step’s own call sits before its own Conversation')
  assert.deepEqual(toolRows(folder).map(row => row.args), ['{"step":0}', '{"step":1}'])
})

test('N3c: a replacement drops a durable BLOCK request too, not just a streamed delta', () => {
  const settled = (withBlock: boolean, seq: number): SessionEvent => eventAt('assistant/message', {
    turn: 1, step: 0,
    message: {
      id: 'm-n3c', role: 'assistant',
      content: withBlock
        ? [{ type: 'text', text: 'reply' }, { type: 'tool-call', id: 'a', name: 'bash', arguments: '{}' }]
        : [{ type: 'text', text: 'reply' }],
      source: { kind: 'assistant' },
    },
    stream: [textChunk(T0 + 2_000, 0, 'reply')],
  }, T0 + 6_000, seq)
  const folder = new TranscriptFolder()
  folder.apply([turnStart(1, T0, 0)])
  folder.apply([settled(true, 1)])
  // The authoritative replacement stops naming A.
  folder.apply([settled(false, 2)])
  folder.apply([
    toolCall({ callId: 'a', name: 'bash', turn: 1, step: 0, time: T0 + 1_000, seq: 3 }),
    toolResult('a', 1, 0, T0 + 1_500, 4, 'ok'),
  ])
  assert.deepEqual(logicalRows(folder), ['assistant:reply', 'tool:a'],
    'the superseded durable block no longer qualifies the later call')
})

test('N3d: dropping a displaced relation reunites the rows it separated (live/cold parity)', () => {
  const events = (): SessionEvent[] => [
    turnStart(1, T0, 0),
    readCall('a', 1, 0, T0 + 3_000, 1, 'a.ts'), toolResult('a', 1, 0, T0 + 3_500, 2, 'alpha'),
    readCall('b', 1, 1, T0 + 4_000, 3, 'b.ts'), toolResult('b', 1, 1, T0 + 4_500, 4, 'bravo'),
    toolCall({ callId: 'x', name: 'bash', turn: 1, step: 2, time: T0 + 5_000, seq: 5 }),
    readCall('c', 1, 3, T0 + 6_000, 6, 'c.ts'), toolResult('c', 1, 3, T0 + 6_500, 7, 'charlie'),
    assistantSettlement({
      turn: 1, step: 0, time: T0 + 9_000, seq: 8, text: 'reply',
      stream: [textChunk(T0 + 2_000, 0, 'reply'), toolCallDeltaChunk(T0 + 3_000, 1, 'a', 'read')],
    }),
    // A reply-only replacement: A's relation departs, so A returns to its
    // physical slot and the rows it had separated must be re-evaluated.
    assistantSettlement({
      turn: 1, step: 0, time: T0 + 9_100, seq: 9, text: 'reply',
      stream: [textChunk(T0 + 2_000, 0, 'reply')],
    }),
  ]
  const live = new TranscriptFolder()
  for (const event of events()) live.apply([event])
  const cold = foldEvents(events())
  assert.equal(toolRows(live).length, 3, 'A+B merge again once A departs; X and C stay separate')
  assert.deepEqual(logicalRows(live), logicalRows(cold),
    'the live departure reflow agrees with the cold fold')
  const merged = toolRows(live).filter(row => row.args === '2 files')
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.callCount, 2)
})
