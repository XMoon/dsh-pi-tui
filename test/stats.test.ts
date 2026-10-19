/**
 * Unit tests for session statistics folding: timing, tokens, cache rate,
 * and the pi-vocabulary stats line.
 * @module @xmoon76/dsh-pi-tui/stats.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId, type AssistantStreamRecord, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RetryId } from '@deepseek-ai/dsh-llm-retry'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { computeStats, sessionStatsFactsOf, StatsFolder, type SessionStats } from '../src/domain/status/stats.ts'
import { formatStatsFacts } from '../src/tui/commands/status.ts'
import { StepUsageAccumulator } from '../src/domain/transcript/usage.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import type { AssistantLiveChunk, AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'

/** Build a minimal event envelope for tests. The type parameter is widened
 * to any string so legacy v1 `assistant/chunk` events (absent from master's
 * SessionEventMap) can be constructed and fed through the live-seam bridge;
 * known types keep their typed data surface, widened with
 * `Record<string, unknown>` so Session v2 fields the installed dsh-session
 * may lag (e.g. `assistant/message.stream`) can be supplied. */
function event<K extends string>(
  type: K,
  data: (K extends SessionEvent['type'] ? SessionEvent<K>['data'] : Record<string, unknown>) & Record<string, unknown>,
  seq: number,
  time = 1_700_000_000_000 + seq * 1000,
): SessionEvent {
  return { type, seq: SessionSeq(seq), time, data } as SessionEvent
}

/** One Session v2 live chunk input (the transient plane replaces durable
 * `assistant/chunk` events). */
function liveChunk(
  turn: number,
  step: number,
  chunk: AssistantLiveChunk,
  time: number,
): AssistantLiveInput {
  return { kind: 'chunk', sessionId: 'test', attemptId: 'attempt-1', turn, step, time, chunk }
}

/** A folder that can fold both the durable event plane and the Session v2
 * live input seam (StatsFolder and TranscriptFolder share this surface). */
interface LiveFoldable {
  apply(events: readonly SessionEvent[]): void
  applyLiveInput(input: AssistantLiveInput): void
}

/** Apply a mixed event list: durable events through `apply()`, legacy
 * `assistant/chunk` events through the live input seam (Session v2). The
 * legacy type is read STRUCTURALLY (master's event union no longer
 * contains it). */
function applyMixed(folder: LiveFoldable, events: readonly SessionEvent[]): void {
  for (const event of events) {
    const kind = event.type as string
    if (kind === 'assistant/chunk') {
      const data = event.data as { turn: number; step: number; chunk: AssistantLiveChunk }
      folder.applyLiveInput(liveChunk(data.turn, data.step, data.chunk, event.time))
    } else {
      folder.apply([event])
    }
  }
}

/** One-shot fold of a mixed event list through the live input seam (the
 * `computeStats` equivalent for logs that still carry legacy
 * `assistant/chunk` events). */
function foldStats(events: readonly SessionEvent[]): SessionStats {
  const folder = new StatsFolder()
  applyMixed(folder, events)
  return folder.snapshot()
}

test('computes turns, steps, LLM time, and first-token latency', () => {
  const t = 1_700_000_000_000
  const folder = new StatsFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'hi' }, t + 1_100))
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: ' there' }, t + 2_000))
  folder.apply([
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('m-1'),
        role: 'assistant',
        content: [{ type: 'text', text: 'hi there' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, 4, t + 8_000),
    event('step/end', { turn: 0, step: 0 }, 5, t + 8_100),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 6, t + 8_200),
  ])
  const stats = folder.snapshot()
  assert.equal(stats.turns, 1)
  assert.equal(stats.steps, 1)
  // LLM wall time ends at assistant/message, never at step/end (Web parity).
  assert.equal(stats.llmMs, 8_000)
})

test('replacement surface messages do not mutate either stats fold', () => {
  const t = 1_700_000_000_000
  const replacement = {
    ...event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('replacement-message'),
        role: 'assistant',
        content: [{ type: 'text', text: 'compaction copy' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 25 },
      stream: [],
    }, 1, t + 100),
    surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) },
  } as SessionEvent
  const log = [event('step/start', { turn: 0, step: 0 }, 0, t), replacement]
  const folded = computeStats(log)
  const incremental = new StatsFolder()
  incremental.apply(log)
  for (const stats of [folded, incremental.snapshot()]) {
    assert.equal(stats.turns, 0)
    assert.equal(stats.steps, 0)
    assert.equal(stats.llmMs, 0)
    assert.equal(stats.inputTokens, 0)
    assert.equal(stats.outputTokens, 0)
    assert.equal(stats.cacheReadTokens, 0)
  }
})

test('a step without an assistant message contributes no timing (Web parity)', () => {
  const t = 1_700_000_000_000
  const folder = new StatsFolder()
  folder.apply([
    event('step/start', { turn: 0, step: 0 }, 0, t),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'hi' }, t + 1_000))
  // Cancelled/failed: step/end arrives, the message never does.
  folder.apply([
    event('step/end', { turn: 0, step: 0 }, 2, t + 5_000),
  ])
  const stats = folder.snapshot()
  assert.equal(stats.steps, 1, 'steps count at step/end')
  assert.equal(stats.turns, 1, 'turns count at step/end (unique)')
  assert.equal(stats.llmMs, 0, 'no message means no wall time')
})

test('open opaque block starts do not create token, usage, or TTFT facts', () => {
  const t = 1_700_000_000_000
  const folder = new StatsFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 100),
  ])
  folder.applyLiveInput(liveChunk(0, 0, {
    type: 'block-start', index: 0, blockType: 'future',
  } as never, t + 500))
  const stats = folder.snapshot()
  assert.equal(stats.llmMs, 0, 'presentation-only open state is not LLM wall time')
  assert.equal(stats.outputTokens, 0, 'presentation-only open state is not output usage')
  assert.equal(stats.inputTokens, 0)
  assert.equal(stats.cacheReadTokens, 0)
  assert.equal(stats.cacheWriteTokens, 0)
})

test('accumulates usage and computes cache hit rate', () => {
  const stats = computeStats([
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('m-1'),
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 9_000, outputTokens: 832, cacheReadTokens: 1_000 },
      stream: [],
    }, 0),
  ])
  assert.equal(stats.inputTokens, 9_000)
  assert.equal(stats.outputTokens, 832)
  assert.equal(stats.cacheHitPct, 10)
})

test('assistant/message falls back to the final embedded stream usage when top-level usage is absent', () => {
  const embedded = { inputTokens: 111, outputTokens: 22, cacheReadTokens: 7, cacheWriteTokens: 3 }
  const stats = computeStats([
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('m-embedded-usage'),
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [
        { type: 'chunk', time: 2, chunk: { type: 'usage', usage: embedded } },
      ],
    }, 0),
  ])
  assert.equal(stats.inputTokens, embedded.inputTokens)
  assert.equal(stats.outputTokens, embedded.outputTokens)
  assert.equal(stats.cacheReadTokens, embedded.cacheReadTokens)
  assert.equal(stats.cacheWriteTokens, embedded.cacheWriteTokens)
})

test('assistant/message top-level usage wins over conflicting embedded stream usage', () => {
  const topLevel = { inputTokens: 200, outputTokens: 30, cacheReadTokens: 4, cacheWriteTokens: 5 }
  const stats = computeStats([
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('m-top-level-usage'),
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: topLevel,
      stream: [
        { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 999, outputTokens: 888, cacheReadTokens: 777, cacheWriteTokens: 666 } } },
      ],
    }, 0),
  ])
  assert.equal(stats.inputTokens, topLevel.inputTokens)
  assert.equal(stats.outputTokens, topLevel.outputTokens)
  assert.equal(stats.cacheReadTokens, topLevel.cacheReadTokens)
  assert.equal(stats.cacheWriteTokens, topLevel.cacheWriteTokens)
})

test('reads the context window from request/context', () => {
  const stats = computeStats([
    event('request/context', { provider: 'p', model: 'm', contextWindow: 1_000_000 }, 0),
  ])
  assert.equal(stats.contextWindow, 1_000_000)
})

test('StatsFolder matches computeStats and folds incrementally', () => {
  const t = 1_700_000_000_000
  const log = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } }, 2, t + 1_100),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: ' there' } }, 3, t + 2_000),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 9_000, outputTokens: 832, cacheReadTokens: 1_000 } } }, 4, t + 3_000),
    event('step/end', { turn: 0, step: 0 }, 5, t + 8_100),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 6, t + 8_200),
  ]
  // One-shot fold: the reference result.
  const oneShot = foldStats(log)
  // Incremental fold: every suffix boundary must agree with the one-shot
  // result for the events applied so far.
  const folder = new StatsFolder()
  for (let index = 0; index < log.length; index += 1) {
    applyMixed(folder, [log[index]!])
    const partial = foldStats(log.slice(0, index + 1))
    const snapshot = folder.snapshot()
    assert.deepEqual(snapshot, partial, `mismatch after event ${index}`)
  }
  const final = folder.snapshot()
  assert.deepEqual(final, oneShot, 'final snapshot must match computeStats')
})

test('StatsFolder bounds completed-turn lifecycle state with a monotonic fence', () => {
  const folder = new StatsFolder()
  for (let turn = 0; turn < 1_024; turn += 1) {
    folder.apply([event('turn/end', { turn, reason: { kind: 'completed' } }, turn)])
  }
  const internals = folder as unknown as {
    completedTurns?: unknown
    completedTurnFence?: number
  }
  assert.equal(internals.completedTurns, undefined)
  assert.equal(internals.completedTurnFence, 1_023)

  // The fence still rejects a late event from the oldest completed turn.
  folder.apply([event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId('late-completed-turn'),
      role: 'assistant',
      content: [{ type: 'text', text: 'late replay' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 10, outputTokens: 5 },
    stream: [],
  }, 2_000)])
  assert.equal(folder.snapshot().outputTokens, 0)
})

test('higher turn/end advances the shared usage fence before older turn/end', () => {
  const t = 1_700_000_000_000
  const prefix = [
    event('step/start', { turn: 0, step: 0 }, 0, t),
    event('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
    }, 1, t + 100),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, t + 200),
  ]
  const folder = new StatsFolder()
  applyMixed(folder, prefix)
  assert.equal(folder.snapshot().outputTokens, 20, 'higher turn/end must finalize the older open usage')
  folder.apply([event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 3, t + 300)])
  assert.equal(folder.snapshot().outputTokens, 20, 'the late older boundary must not commit it twice')
  assert.equal(foldStats(prefix).outputTokens, 20)
})

test('duplicate assistant messages settle timing only once', () => {
  const t = 1_700_000_000_000
  const message = (seq: number, time: number, outputTokens = 100): SessionEvent => event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`m-duplicate-${seq}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 10, outputTokens },
    stream: [],
  }, seq, time)
  const log = [
    event('step/start', { turn: 0, step: 0 }, 0, t),
    event('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: 'answer' },
    }, 1, t + 100),
    event('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: ' answer' },
    }, 2, t + 200),
    message(3, t + 1_100),
    // A duplicate authoritative event is anomalous, but must not turn one
    // model step into two timing/throughput samples.
    message(4, t + 2_100, 200),
    event('step/end', { turn: 0, step: 0 }, 5, t + 2_200),
  ]
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  assert.equal(oneShot.llmMs, 1_100)
  // The duplicate replaced the sample in place: 200 tokens over the SAME
  // 1000 ms decode span (first token → message; one sample, never two).
  assert.equal(oneShot.outputTokens, 200)
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('one turn with many steps keeps late-message retention on a cheap turn fence', () => {
  const t = 1_700_000_000_000
  const events: SessionEvent[] = [event('turn/start', { turn: 0 }, 0, t)]
  let seq = 1
  for (let step = 0; step < 1_000; step += 1) {
    events.push(event('step/start', { turn: 0, step }, seq++, t + seq))
    events.push(event('assistant/chunk', {
      turn: 0,
      step,
      chunk: { type: 'text-delta', index: 0, text: 'x' },
    }, seq++, t + seq))
    events.push(event('assistant/message', {
      turn: 0,
      step,
      message: {
        id: MessageId(`m-many-step-${step}`),
        role: 'assistant',
        content: [{ type: 'text', text: 'x' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      stream: [],
    }, seq++, t + seq))
    events.push(event('step/end', { turn: 0, step }, seq++, t + seq))
  }
  events.push(event('turn/end', { turn: 0, reason: { kind: 'completed' } }, seq, t + seq))

  const oneShot = foldStats(events)
  const folder = new StatsFolder()
  applyMixed(folder, events)
  assert.deepEqual(folder.snapshot(), oneShot)
  assert.equal(oneShot.steps, 1_000)
  assert.equal(oneShot.outputTokens, 1_000)
  assert.equal((folder as unknown as { settledTurn: number | undefined }).settledTurn, 0)
  assert.equal((folder as unknown as { perStep: Map<unknown, unknown> }).perStep.size, 0,
    'the current turn keeps no open timing entry after every step settled')
})

test('older duplicate messages cannot mutate timing after a higher turn starts', () => {
  const t = 1_700_000_000_000
  const message = (seq: number, time: number, outputTokens: number): SessionEvent => event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`m-stale-turn-${seq}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 10, outputTokens },
    stream: [],
  }, seq, time)
  const log = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t),
    event('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: 'answer' },
    }, 2, t + 100),
    event('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: ' answer' },
    }, 3, t + 150),
    message(4, t + 200, 100),
    // No step/end yet: this settled timing is still in perStep when the
    // next turn opens, which is the stale-entry replay shape.
    event('turn/start', { turn: 1 }, 5, t + 300),
    message(6, t + 400, 200),
  ]
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  // The late duplicate is stale for both folds: the original sample and
  // output-token total remain authoritative. 100 tokens over the 100 ms
  // decode span (first token → message) = 1000 tok/s.
  assert.equal(oneShot.llmMs, 200)
  assert.equal(oneShot.outputTokens, 100)
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('duplicate step/start preserves settled timing and a duplicate end is idempotent', () => {
  const t = 1_700_000_000_000
  const message = (seq: number, time: number, outputTokens: number): SessionEvent => event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`m-duplicate-boundary-${seq}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 10, outputTokens },
    stream: [],
  }, seq, time)
  const log = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t),
    event('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: 'answer' },
    }, 2, t + 10),
    event('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: ' answer' },
    }, 3, t + 20),
    message(4, t + 110, 100),
    // A duplicate start before the first end must preserve the settled timing
    // object rather than resetting its start/settled state.
    event('step/start', { turn: 0, step: 0 }, 5, t + 150),
    message(6, t + 210, 200),
    event('step/end', { turn: 0, step: 0 }, 7, t + 220),
    // The same replay can repeat both boundaries after the first end.
    event('step/start', { turn: 0, step: 0 }, 8, t + 230),
    message(9, t + 310, 300),
    event('step/end', { turn: 0, step: 0 }, 10, t + 320),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 11, t + 330),
  ]
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  assert.equal(oneShot.turns, 1)
  assert.equal(oneShot.steps, 1)
  assert.equal(oneShot.llmMs, 110)
  // The replacement settled the same step in place: 300 tokens over the
  // SAME 100 ms decode span (first token → message) — one sample, never two.
  assert.equal(oneShot.outputTokens, 300)
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('an older step/end cannot increment stats after a higher turn starts', () => {
  const t = 1_700_000_000_000
  const log = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 1),
    event('turn/start', { turn: 1 }, 2, t + 2),
    event('step/start', { turn: 1, step: 0 }, 3, t + 3),
    event('step/end', { turn: 1, step: 0 }, 4, t + 4),
    // The turn-0 boundary is stale and must not create a second step/turn.
    event('step/end', { turn: 0, step: 0 }, 5, t + 5),
  ]
  const oneShot = computeStats(log)
  const folder = new StatsFolder()
  folder.apply(log)
  assert.equal(oneShot.turns, 1)
  assert.equal(oneShot.steps, 1)
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('formats the lifetime LLM wall as a readable duration at scale', () => {
  const at = (llmMs: number): string => formatStatsFacts({ lifetime: { turns: 1, steps: 1, llmMs } })
  assert.ok(at(8_100).includes('LLM 8.1s'), 'under a minute keeps the decimal seconds')
  assert.ok(at(1_674_000).includes('LLM 27m54s'), 'minutes render as MmSSs')
  assert.ok(at(3_965_000).includes('LLM 1h06m05s'), 'hours render as HhMMmSSs')
})

test('usage is counted once per step despite chunk and message both carrying it', () => {
  const t = 1_700_000_000_000
  const folder = new StatsFolder()
  folder.apply([
    event('step/start', { turn: 0, step: 0 }, 0, t),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'usage', usage: { inputTokens: 9_000, outputTokens: 832, cacheReadTokens: 1_000 } }, t + 1_000))
  folder.apply([
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('m-1'),
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 9_000, outputTokens: 832, cacheReadTokens: 1_000 },
      stream: [],
    }, 2, t + 2_000),
    event('step/end', { turn: 0, step: 0 }, 3, t + 3_000),
  ])
  const stats = folder.snapshot()
  // The same assembler usage rides both events; adding both would double it.
  assert.equal(stats.inputTokens, 9_000)
  assert.equal(stats.outputTokens, 832)
  assert.equal(stats.cacheReadTokens, 1_000)
  assert.equal(stats.cacheHitPct, 10)
})

test('turn/start advances the accumulator: a delayed prior-turn usage fact is stale', () => {
  const t = 1_700_000_000_000
  const events = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 1),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } }, 2, t + 2),
    event('turn/start', { turn: 1 }, 3, t + 3),
    // A delayed usage fact for the prior turn (replay artifact).
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 200, outputTokens: 0 } } }, 4, t + 4),
    event('step/end', { turn: 0, step: 0 }, 5, t + 5),
  ]
  const stats = foldStats(events)
  const folder = new TranscriptFolder()
  applyMixed(folder, events)
  assert.equal(stats.inputTokens, 100, 'the delayed prior-turn fact must be stale')
  assert.equal(folder.turnActivity(0)!.totalTokens, 100, 'the Focus per-turn total must agree with the footer')
})

test('turn/end drops the open timing entries of the ended turn', () => {
  const folder = new StatsFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'hi' }, 1_700_000_000_002))
  // turn/end arrives while the step is still open (interrupted).
  folder.apply([
    event('turn/end', { turn: 0, reason: { kind: 'interrupted' } }, 3),
  ])
  const perStep = (folder as unknown as { perStep: Map<string, unknown> }).perStep
  assert.equal(perStep.size, 0, 'the open timing entries of the ended turn must be dropped')
})

test('turn/end with an open step finalizes its usage in BOTH folds', () => {
  const t = 1_700_000_000_000
  const events = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 1),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } }, 2, t + 2),
    // turn/end arrives while the step is still open.
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 3, t + 3),
    // A late step/end (replay artifact) must not change anything.
    event('step/end', { turn: 0, step: 0 }, 4, t + 4),
  ]
  const stats = foldStats(events)
  const folder = new TranscriptFolder()
  applyMixed(folder, events)
  assert.equal(stats.inputTokens, 100, 'the footer must finalize the open step at turn/end')
  assert.equal(folder.turnActivity(0)!.totalTokens, 100, 'the Focus per-turn total must agree with the footer')
})

test('late usage after turn/end is ignored by BOTH the stats fold and the Focus fold', () => {
  const t = 1_700_000_000_000
  const events = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 1),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } }, 2, t + 2),
    event('step/end', { turn: 0, step: 0 }, 3, t + 3),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4, t + 4),
    // A late usage fact (replay artifact): both folds must ignore it. The
    // Session v2 transient expression of a late usage fact is a live chunk
    // (routed through the live seam by applyMixed); both folds reject it
    // via their completed-turn gates (StatsFolder: completedTurnFence,
    // TranscriptFolder: activity.completed).
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 200, outputTokens: 0 } } }, 5, t + 5),
  ]
  const stats = foldStats(events)
  const folder = new TranscriptFolder()
  applyMixed(folder, events)
  assert.equal(stats.inputTokens, 100, 'the footer must ignore the late usage fact')
  assert.equal(folder.turnActivity(0)!.totalTokens, 100, 'the Focus per-turn total must agree with the footer')
})

test('an assistant/attempt counts the last usage in its durable stream', () => {
  const t = 1_700_000_000_000
  const events = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 1),
    // The live value is provisional and differs from the durable settlement.
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 90, outputTokens: 4 } } }, 2, t + 2),
    event('assistant/attempt', {
      turn: 0,
      step: 0,
      stream: [
        { type: 'chunk', time: t + 3, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } } },
        { type: 'chunk', time: t + 4, chunk: { type: 'usage', usage: { inputTokens: 120, outputTokens: 7 } } },
      ],
    }, 3, t + 3),
    event('step/end', { turn: 0, step: 0 }, 4, t + 4),
    event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 5, t + 5),
  ]
  const stats = foldStats(events)
  assert.equal(stats.inputTokens, 120, 'the durable attempt replaces, not adds to, live provisional usage')
  assert.equal(stats.outputTokens, 7)
  // Reopen parity: the cold durable replay sees the same authoritative usage.
  const cold = computeStats(events.filter(item => (item.type as string) !== 'assistant/chunk'))
  assert.equal(cold.inputTokens, 120, 'cold replay agrees with the live fold')
  assert.equal(cold.outputTokens, 7)
})

test('a retry accumulates attempts while settling logical-step timing once', () => {
  const t = 1_700_000_000_000
  const events = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 100),
    // The FAILED attempt streams two token deltas at distinct timestamps:
    // without the attempt/retry decode reset they would look observable.
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'failed' } }, 2, t + 200),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: ' attempt' } }, 3, t + 250),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } } }, 4, t + 220),
    event('assistant/attempt', {
      turn: 0,
      step: 0,
      stream: [{ type: 'chunk', time: t + 300, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } } }],
    }, 5, t + 300),
    event('llm/retry', {
      retryId: 'retry-1' as RetryId,
      turn: 0,
      step: 0,
      provider: 'p',
      mode: 'normal',
      policyKey: 'test',
      retry: 1,
      maxRetries: 2,
      delayMs: 0,
      failure: { message: 'failed', code: 'TEST' },
    }, 6, t + 400),
    event('llm/retry-started', { retryId: 'retry-1' as RetryId, turn: 0, step: 0, retry: 1 }, 7, t + 500),
    // retry on the SAME step streams a fresh cumulative usage fact
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 200, outputTokens: 9 } } }, 8, t + 600),
    // The SUCCESSFUL attempt's decode span starts at its own first token.
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'ok' } }, 9, t + 650),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: '!' } }, 10, t + 700),
    event('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('m-retry'), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 200, outputTokens: 9 },
      stream: [],
    }, 11, t + 800),
    event('step/end', { turn: 0, step: 0 }, 12, t + 900),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 13, t + 1_000),
  ]
  const stats = foldStats(events)
  assert.equal(stats.inputTokens, 300, 'the failed attempt and retry usage are both billed')
  assert.equal(stats.outputTokens, 14)
  assert.equal(stats.llmMs, 700, 'the retry reuses the original step start for wall time')
  // Throughput uses ONLY the successful attempt's decode span: 9 tokens
  // over 800 − 650 = 150 ms — never the failed attempt's tokens or the
  // step/start → message wall.
  const cold = computeStats(events.filter(item => (item.type as string) !== 'assistant/chunk'))
  assert.equal(cold.inputTokens, 300, 'cold replay keeps both attempt totals')
  assert.equal(cold.outputTokens, 14)
  assert.equal(cold.llmMs, 700, 'cold replay retains the open timing until the final message')
})

test('a live assistant/attempt settlement keeps timing open for its retry', () => {
  const t = 1_700_000_000_000
  const folder = new StatsFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 100),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'failed' }, t + 200))
  folder.applyLiveInput({
    kind: 'end',
    sessionId: 'test',
    attemptId: 'attempt-1',
    turn: 0,
    step: 0,
    status: 'committed',
    settlement: 'attempt',
  })
  folder.apply([
    event('assistant/attempt', {
      turn: 0,
      step: 0,
      stream: [{ type: 'chunk', time: t + 300, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } } }],
    }, 2, t + 300),
    event('llm/retry-started', { retryId: 'retry-live' as RetryId, turn: 0, step: 0, retry: 1 }, 3, t + 500),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: { id: MessageId('m-live-retry'), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 200, outputTokens: 9 },
      stream: [],
    }, 4, t + 800),
    event('step/end', { turn: 0, step: 0 }, 5, t + 900),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 6, t + 1_000),
  ])
  const stats = folder.snapshot()
  assert.equal(stats.llmMs, 700)
  assert.equal(stats.inputTokens, 300)
  assert.equal(stats.outputTokens, 14)
})

test('without llm/retry-started, a later same-step settlement replaces the slot', () => {
  const usageA = { inputTokens: 100, outputTokens: 5 }
  const usageB = { inputTokens: 200, outputTokens: 9 }
  const events = [
    event('assistant/attempt', {
      turn: 0,
      step: 0,
      stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: usageA } }],
    }, 0),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: { id: MessageId('m-no-retry'), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: usageB,
      stream: [],
    }, 1),
  ]
  const stats = computeStats(events)
  assert.equal(stats.inputTokens, 200)
  assert.equal(stats.outputTokens, 9)
})

test('a late assistant/attempt replaces a settled message usage in both folds', () => {
  const topLevelUsage = { inputTokens: 10, outputTokens: 100 }
  const embeddedUsage = { inputTokens: 20, outputTokens: 200 }
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: { id: MessageId('m-settled-before-attempt'), role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: topLevelUsage,
      stream: [],
    }, 2),
    event('assistant/attempt', {
      turn: 0,
      step: 0,
      stream: [{ type: 'chunk', time: 3, chunk: { type: 'usage', usage: embeddedUsage } }],
    }, 3),
    event('step/end', { turn: 0, step: 0 }, 4),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
  ]
  const transcript = new TranscriptFolder()
  transcript.apply(events)
  const activity = transcript.turnActivity(0)
  assert.deepEqual(activity?.usage, { inputTokens: 20, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.equal(activity?.totalTokens, 220)
  assert.equal(activity?.assistantMessages, 1)
  const stats = foldStats(events)
  assert.equal(stats.inputTokens, 20)
  assert.equal(stats.outputTokens, 200)
  const cold = computeStats(events)
  assert.equal(cold.inputTokens, 20)
  assert.equal(cold.outputTokens, 200)
})

test('a usage-less late attempt preserves authoritative message usage in both folds', () => {
  const usage = { inputTokens: 10, outputTokens: 100 }
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: { id: MessageId('m-authoritative-usage'), role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage,
      stream: [],
    }, 2),
    event('assistant/attempt', { turn: 0, step: 0, stream: [] }, 3),
    event('step/end', { turn: 0, step: 0 }, 4),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
  ]
  const transcript = new TranscriptFolder()
  transcript.apply(events)
  assert.equal(transcript.turnActivity(0)?.usage?.inputTokens, 10)
  assert.equal(transcript.turnActivity(0)?.usage?.outputTokens, 100)
  const stats = foldStats(events)
  assert.equal(stats.inputTokens, 10)
  assert.equal(stats.outputTokens, 100)
  const cold = computeStats(events)
  assert.equal(cold.inputTokens, 10)
  assert.equal(cold.outputTokens, 100)
})

test('a duplicate step/start never leaks the open step pending usage', () => {
  const acc = new StepUsageAccumulator()
  acc.onStepStart(0, 0)
  acc.onUsageChunk(0, 0, { inputTokens: 100, outputTokens: 0 })
  acc.onStepStart(0, 0) // duplicate
  acc.onStepEnd(0, 0)
  assert.equal(acc.sessionTotals().inputTokens, 100, 'the duplicate start must not lose the pending usage')
})

test('a durable failed attempt commits usage and retry-started opens an additive slot', () => {
  const acc = new StepUsageAccumulator()
  acc.onStepStart(0, 0)
  acc.onUsageChunk(0, 0, { inputTokens: 90, outputTokens: 4 })
  acc.onAssistantAttempt(0, 0, { inputTokens: 100, outputTokens: 5 })
  assert.equal(acc.sessionTotals().inputTokens, 100)
  acc.onRetryStarted(0, 0)
  acc.onUsageChunk(0, 0, { inputTokens: 200, outputTokens: 9 })
  acc.onAssistantMessage(0, 0, { inputTokens: 200, outputTokens: 9 })
  acc.onStepEnd(0, 0)
  assert.equal(acc.sessionTotals().inputTokens, 300)
  assert.equal(acc.sessionTotals().outputTokens, 14)
})

test('discardStep drops an ABANDONED attempt\'s provisional usage without committing it', () => {
  const acc = new StepUsageAccumulator()
  acc.onStepStart(0, 0)
  acc.onUsageChunk(0, 0, { inputTokens: 100, outputTokens: 0 })
  acc.discardStep(0, 0) // the live attempt was abandoned without a durable event
  assert.equal(acc.sessionTotals().inputTokens, 0, 'nothing was committed for the failed attempt')
  assert.equal(acc.turnUsageWithPending(0), undefined, 'the turn shows no usage for the failed step')
  acc.onStepEnd(0, 0)
  assert.equal(acc.sessionTotals().inputTokens, 0, 'the closed failed step commits nothing')
})

test('discardStep never discards an AUTHORITATIVE value the durable log owns', () => {
  const acc = new StepUsageAccumulator()
  acc.onStepStart(0, 0)
  acc.onUsageChunk(0, 0, { inputTokens: 100, outputTokens: 0 })
  acc.onAssistantMessage(0, 0, { inputTokens: 200, outputTokens: 0 }) // durable settlement
  acc.discardStep(0, 0) // a stale replay artifact must not wipe the settled usage
  acc.onStepEnd(0, 0)
  assert.equal(acc.sessionTotals().inputTokens, 200, 'the authoritative usage survives')
})

test('a late fact for an OLDER turn is ignored after the turn advanced (no double count)', () => {
  const acc = new StepUsageAccumulator()
  acc.onStepStart(0, 0)
  acc.onUsageChunk(0, 0, { inputTokens: 100, outputTokens: 0 })
  acc.onStepEnd(0, 0)
  acc.onStepStart(1, 0) // the turn advances; turn 0's records are dropped
  // A late fact for turn 0's closed step must be ignored, never re-counted.
  acc.onUsageChunk(0, 0, { inputTokens: 120, outputTokens: 0 })
  acc.onAssistantMessage(0, 0, { inputTokens: 130, outputTokens: 0 })
  assert.equal(acc.sessionTotals().inputTokens, 100, 'the stale older-turn facts must be ignored')
  assert.equal(acc.turnUsageWithPending(0)?.inputTokens, 100, 'turn 0\'s committed total survives untouched')
})

test('advancing turns finalizes older open steps and drops their pending', () => {
  const acc = new StepUsageAccumulator()
  acc.onStepStart(0, 0)
  acc.onUsageChunk(0, 0, { inputTokens: 100, outputTokens: 0 })
  // Turn 1 starts while turn 0's step is still open (fragmented log).
  acc.onStepStart(1, 0)
  const perStep = (acc as unknown as { perStep: Map<string, unknown> }).perStep
  const turnPending = (acc as unknown as { turnPending: Map<number, unknown> }).turnPending
  assert.equal(perStep.size, 1, 'only turn 1\'s open step remains')
  assert.equal(turnPending.has(0), false, 'turn 0\'s pending is dropped')
  assert.equal(acc.turnUsageWithPending(0)?.inputTokens, 100, 'turn 0\'s usage is finalized into its committed totals')
  assert.equal(acc.sessionTotals().inputTokens, 100, 'the session total keeps the finalized usage')
})

test('the accumulator drops settled records of older turns (bounded lifecycle)', () => {
  const acc = new StepUsageAccumulator()
  acc.onStepStart(0, 0)
  acc.onUsageChunk(0, 0, { inputTokens: 100, outputTokens: 0 })
  acc.onStepEnd(0, 0)
  const settled = (acc as unknown as { settledByStep: Map<string, unknown> }).settledByStep
  assert.equal(settled.size, 1, 'the closed step is tracked while its turn is current')
  // A new turn's step/start drops the older turn's records.
  acc.onStepStart(1, 0)
  assert.equal(settled.size, 0, 'older turns\' records are dropped when the turn advances')
  // The committed totals survive the cleanup.
  assert.equal(acc.sessionTotals().inputTokens, 100)
})

test('StatsFolder drops the step timing entry at step/end (no unbounded growth)', () => {
  const folder = new StatsFolder()
  folder.apply([
    event('step/start', { turn: 0, step: 0 }, 0),
  ])
  folder.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'hi' }, 1_700_000_000_001))
  folder.apply([
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('m-1'),
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, 2),
    event('step/end', { turn: 0, step: 0 }, 3),
  ])
  const perStep = (folder as unknown as { perStep: Map<string, unknown> }).perStep
  assert.equal(perStep.size, 0, 'the step timing entry must be dropped at step/end')
  // The settled timing survives in the snapshot.
  assert.equal(folder.snapshot().llmMs, 2_000)
})

test('llmMs spans step/start to assistant/message, not to step/end', () => {
  const t = 1_700_000_000_000
  const stats = computeStats([
    event('step/start', { turn: 0, step: 0 }, 0, t),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('m-3'),
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, 1, t + 2_000),
    // A long tool run after the message must not extend the LLM wall time.
    event('step/end', { turn: 0, step: 0 }, 2, t + 9_000),
  ])
  assert.equal(stats.llmMs, 2_000)
})

// ── Recent performance contract (recent-5 observable decode throughput / TTFB) ───

/** One completed step with a model-source identity and usage. Every step
 * carries TWO token-bearing deltas at distinct timestamps so it is an
 * OBSERVABLE decode sample: the first at `firstDeltaMs` (or
 * `wallMs - decodeMs` when unspecified) and the second 100 ms later. The
 * decode span defaults to the full wall (`decodeMs = wallMs`), keeping the
 * pooled-rate math of the window tests on the wall scale. `tokenDeltas:
 * false` emits no deltas (a burst step / missing TTFT evidence). */
function completedStep(
  turn: number,
  step: number,
  startSeq: number,
  startTime: number,
  options: {
    provider?: string
    model?: string
    outputTokens?: number
    wallMs?: number
    firstDeltaMs?: number
    decodeMs?: number
    tokenDeltas?: boolean
  } = {},
): SessionEvent[] {
  const wallMs = options.wallMs ?? 1_000
  const decodeMs = options.decodeMs ?? wallMs
  const firstDeltaMs = options.firstDeltaMs ?? wallMs - decodeMs
  const events: SessionEvent[] = [
    event('step/start', { turn, step }, startSeq, startTime),
  ]
  let seq = startSeq
  if (options.tokenDeltas !== false) {
    seq += 1
    events.push(event('assistant/chunk', {
      turn,
      step,
      chunk: { type: 'text-delta', index: 0, text: 'answer' },
    }, seq, startTime + firstDeltaMs))
    seq += 1
    events.push(event('assistant/chunk', {
      turn,
      step,
      chunk: { type: 'text-delta', index: 0, text: ' answer' },
    }, seq, startTime + firstDeltaMs + 100))
  }
  seq += 1
  events.push(event('assistant/message', {
    turn,
    step,
    message: {
      id: MessageId(`m-recent-${turn}-${step}-${startSeq}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: options.provider ?? 'p', model: options.model ?? 'm' },
    },
    usage: { inputTokens: 10, outputTokens: options.outputTokens ?? 100 },
    stream: [],
  }, seq, startTime + wallMs))
  seq += 1
  events.push(event('step/end', { turn, step }, seq, startTime + wallMs + 100))
  return events
}

test('a burst route keeps token totals identical to the pre-recent accounting', () => {
  const t = 1_700_000_000_000
  const log: SessionEvent[] = []
  let seq = 0
  for (let step = 0; step < 8; step += 1) {
    const events = completedStep(0, step, seq, t + step * 10_000, { outputTokens: 400, wallMs: 100 })
    log.push(...events)
    seq += events.length
  }
  const stats = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  // Observable decode throughput may exceed 1 tok/ms on fast routes —
  // nothing clamps it (plan §11: no TPS clamps).
  // Usage accounting is untouched by the performance window.
  assert.equal(stats.outputTokens, 3_200)
  assert.equal(stats.steps, 8)
  assert.deepEqual(folder.snapshot(), stats)
})

test('PR-2 formatStatsFacts renders each Host performance fact on its own availability', () => {
  const full: import('../src/domain/status/stats.ts').SessionStatsFacts = {
    lifetime: { turns: 12, steps: 38, llmMs: 120000 },
    tokens: { input: 2579, output: 5507, cacheRead: 20000, cacheWrite: 0, cacheHitPct: 88.6 },
    recent: { firstTokenMsAvg: 2000, tokensPerSec: 40 },
    sessionPerformance: { tokensPerSec: 12 },
  }
  const fullLine = formatStatsFacts(full)
  assert.ok(fullLine.includes('t12') && fullLine.includes('s38'), 'lifetime renders')
  assert.ok(fullLine.includes('↑2.6k') && fullLine.includes('↓5.5k'), 'tokens render')
  assert.ok(fullLine.includes('R20k') && fullLine.includes('CH'), 'Direct cache R/W display parity (review R6-6)')
  assert.ok(fullLine.includes('TTFB 2s') && fullLine.includes('R5 40 tok/s') && fullLine.includes('All 12 tok/s'),
    'the three Host facts render with their own labels')

  // The Host projection answers each fact independently: an absent field is
  // OMITTED (unknown), never a fabricated zero.
  const facts: import('../src/domain/status/stats.ts').SessionStatsFacts = { recent: {}, sessionPerformance: undefined }
  assert.equal(formatStatsFacts(facts), 'unmeasured', 'no answered performance fact reads unmeasured')
  assert.equal(formatStatsFacts({ recent: { firstTokenMsAvg: 1500 } }), 'TTFB 1.5s', 'TTFB alone')
  assert.equal(formatStatsFacts({ recent: { tokensPerSec: 40 } }), 'R5 40 tok/s', 'R5 alone')
  assert.equal(formatStatsFacts({ sessionPerformance: { tokensPerSec: 12 } }), 'All 12 tok/s', 'All alone')

  const lifetimeOnly: import('../src/domain/status/stats.ts').SessionStatsFacts = { lifetime: { llmMs: 120000 } }
  const lifetimeLine = formatStatsFacts(lifetimeOnly)
  assert.ok(lifetimeLine.includes('LLM 2m') && !lifetimeLine.includes('TTFB') && !lifetimeLine.includes('↑'),
    'absent token/performance groups are OMITTED (never ↑0 ↓0 / TTFB 0s stand-ins)')

  assert.equal(formatStatsFacts({}), 'unmeasured', 'no known group reads unmeasured')

  const zeros: import('../src/domain/status/stats.ts').SessionStatsFacts = {
    lifetime: { turns: 0, steps: 0, llmMs: 0 },
    recent: { firstTokenMsAvg: 0, tokensPerSec: 0 },
  }
  const zeroLine = formatStatsFacts(zeros)
  assert.ok(zeroLine.includes('t0') && zeroLine.includes('TTFB 0s') && zeroLine.includes('R5 0 tok/s'),
    'authoritative ZEROS render as visible zeros (not absence)')
})

test('PR-2 sessionStatsFactsOf takes the performance groups from the Host-derived facts', () => {
  const stats = computeStats([])
  const bare = sessionStatsFactsOf(stats)
  assert.ok(bare.lifetime !== undefined && bare.tokens !== undefined, 'the fold owns lifetime and tokens')
  assert.equal(bare.recent, undefined, 'no Host figures: the recent group is ABSENT, never zeros')
  assert.equal(bare.sessionPerformance, undefined, 'no Host figures: the All group is ABSENT')

  const withHost = sessionStatsFactsOf(stats, { firstTokenMs: 2000, tokensPerSec: 40, sessionTokensPerSec: 12 })
  assert.deepEqual(withHost.recent, { firstTokenMsAvg: 2000, tokensPerSec: 40 })
  assert.deepEqual(withHost.sessionPerformance, { tokensPerSec: 12 })

  // Asymmetric availability: a TTFB-only derivation omits only the rate.
  const ttfbOnly = sessionStatsFactsOf(stats, { firstTokenMs: 2000 })
  assert.deepEqual(ttfbOnly.recent, { firstTokenMsAvg: 2000 })
  assert.equal(ttfbOnly.sessionPerformance, undefined)
})
