/**
 * Unit tests for session statistics folding: timing, tokens, cache rate,
 * and the pi-vocabulary stats line.
 * @module @xmoon76/dsh-pi-tui/stats.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId, type AssistantStreamRecord, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { computeStats, formatStats, StatsFolder, type SessionStats } from '../src/stats.ts'
import { StepUsageAccumulator } from '../src/token-usage.ts'
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
  return { type, seq, time, data } as SessionEvent
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
  assert.equal(stats.firstTokenMsAvg, 1_100)
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
    surfaceOp: { op: 'replace', start: 0, end: 0 },
  } as SessionEvent
  const log = [event('step/start', { turn: 0, step: 0 }, 0, t), replacement]
  const folded = computeStats(log)
  const incremental = new StatsFolder()
  incremental.apply(log)
  for (const stats of [folded, incremental.snapshot()]) {
    assert.equal(stats.turns, 0)
    assert.equal(stats.steps, 0)
    assert.equal(stats.llmMs, 0)
    assert.equal(stats.firstTokenMsAvg, 0)
    assert.equal(stats.tokensPerSec, 0)
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
  assert.equal(stats.firstTokenMsAvg, 0, 'no message means no TTFT')
  assert.equal(stats.tokensPerSec, 0)
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
  assert.equal(stats.firstTokenMsAvg, 0, 'presentation-only open state is not TTFT')
  assert.equal(stats.llmMs, 0, 'presentation-only open state is not LLM wall time')
  assert.equal(stats.outputTokens, 0, 'presentation-only open state is not output usage')
  assert.equal(stats.inputTokens, 0)
  assert.equal(stats.cacheReadTokens, 0)
  assert.equal(stats.cacheWriteTokens, 0)
})

test('first-token semantics match the Web isTokenDelta: reasoning deltas start the decode window', () => {
  const t = 1_700_000_000_000
  // Step 0: reasoning delta arrives first, text delta later. The decode
  // window must start at the FIRST reasoning token (4500 ms), not at the
  // first visible text (4000 ms) — the old text-delta-only stamp made
  // tok/s systematically high on reasoning models.
  const log = [
    event('step/start', { turn: 0, step: 0 }, 0, t),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'let me think' } }, 1, t + 500),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'answer' } }, 2, t + 1_000),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('m-1'),
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 450, cacheReadTokens: 0 },
      stream: [],
    }, 3, t + 5_000),
    event('step/end', { turn: 0, step: 0 }, 4, t + 6_000),
    // Step 1: two tool-call deltas at distinct timestamps — also a token
    // delta start, and observable enough to join the throughput window.
    event('step/start', { turn: 1, step: 0 }, 5, t + 7_000),
    event('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'tool-call-delta', index: 0, id: 'tc-1' as ToolCallId, name: 'bash', argumentsDelta: '{"command"' } }, 6, t + 7_100),
    event('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'tool-call-delta', index: 0, id: 'tc-1' as ToolCallId, name: 'bash', argumentsDelta: '"ls"}' } }, 7, t + 7_200),
    event('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: MessageId('m-2'),
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'tc-1' as ToolCallId, name: 'bash', arguments: '{"command":"ls"}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 50, cacheReadTokens: 0 },
      stream: [],
    }, 8, t + 7_600),
    event('step/end', { turn: 1, step: 0 }, 9, t + 8_000),
  ]
  const stats = foldStats(log)
  // Step 0: 450 tokens over the observable decode span (first reasoning
  // token → message: 5000 − 500 = 4500 ms). Step 1: 50 tokens over
  // 7600 − 7100 = 500 ms. The pooled decode throughput:
  // 500 tokens / 5000 ms.
  assert.equal(stats.tokensPerSec, Math.round((500 * 1000) / 5_000), `observable decode throughput pools both steps:\n${JSON.stringify(stats)}`)
  // TTFT averages both steps: 500 ms (step 0: start → first reasoning
  // delta) and 100 ms (step 1: start → first tool-call delta).
  assert.equal(stats.firstTokenMsAvg, 300)
  assert.equal(stats.outputTokens, 500)
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

test('assistant/message embedded stream supplies durable first-token timing', () => {
  const t = 1_700_000_000_000
  const stats = computeStats([
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 100),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('m-embedded-ttft'),
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [
        { type: 'text-chunks' as const, time0: t + 250, index: 0, dt: [], texts: ['ok'] },
        { type: 'chunk' as const, time: t + 300, chunk: { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 2 } } },
      ],
    }, 2, t + 900),
    event('step/end', { turn: 0, step: 0 }, 3, t + 950),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4, t + 1000),
  ])
  assert.equal(stats.firstTokenMsAvg, 150)
  assert.equal(stats.inputTokens, 10)
  assert.equal(stats.outputTokens, 2)
})

test('live and cold StatsFolder keep reasoning/tool compact-stream TTFT parity', () => {
  const t = 1_700_000_000_000
  const cases = [
    {
      name: 'reasoning',
      chunk: { type: 'reasoning-delta' as const, index: 0, text: 'think' },
      content: [{ type: 'text' as const, text: 'answer' }],
      firstTime: t + 250,
      expected: 150,
    },
    {
      name: 'tool-call',
      chunk: { type: 'tool-call-delta' as const, index: 0, id: 'ttft-tool' as ToolCallId, name: 'bash', argumentsDelta: '{' },
      content: [{ type: 'tool-call' as const, id: 'ttft-tool' as ToolCallId, name: 'bash', arguments: '{}' }],
      firstTime: t + 300,
      expected: 200,
    },
    {
      name: 'no-token',
      chunk: { type: 'block-start' as const, index: 0, blockType: 'text' as const },
      content: [{ type: 'text' as const, text: 'answer' }],
      firstTime: t + 250,
      expected: 0,
    },
  ]
  for (const [index, item] of cases.entries()) {
    const stream = [{ type: 'chunk' as const, time: item.firstTime, chunk: item.chunk }]
    const message = event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId(`m-compact-ttft-${item.name}`),
        role: 'assistant',
        content: item.content,
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream,
    }, index + 2, t + 900)
    const boundary = [
      event('turn/start', { turn: 0 }, 0, t),
      event('step/start', { turn: 0, step: 0 }, 1, t + 100),
      message,
      event('step/end', { turn: 0, step: 0 }, 3, t + 950),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4, t + 1000),
    ]
    const live = new StatsFolder()
    live.apply([boundary[0]!, boundary[1]!])
    live.applyLiveInput(liveChunk(0, 0, item.chunk, item.firstTime))
    live.apply(boundary.slice(2))
    const cold = new StatsFolder()
    cold.apply(boundary)
    assert.equal(live.snapshot().firstTokenMsAvg, item.expected, `${item.name}: live TTFT`)
    assert.equal(cold.snapshot().firstTokenMsAvg, item.expected, `${item.name}: cold TTFT`)
  }
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
    assert.deepEqual(
      { ...snapshot, firstTokenMsAvg: Math.round(snapshot.firstTokenMsAvg * 1000) / 1000 },
      { ...partial, firstTokenMsAvg: Math.round(partial.firstTokenMsAvg * 1000) / 1000 },
      `mismatch after event ${index}`,
    )
  }
  const final = folder.snapshot()
  assert.deepEqual(
    { ...final, firstTokenMsAvg: Math.round(final.firstTokenMsAvg * 1000) / 1000 },
    { ...oneShot, firstTokenMsAvg: Math.round(oneShot.firstTokenMsAvg * 1000) / 1000 },
    'final snapshot must match computeStats',
  )
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

test('StatsFolder keeps the recent throughput window bounded', () => {
  const t = 1_700_000_000_000
  const folder = new StatsFolder()
  // 12 completed steps: the window must hold only the LATEST 5 samples.
  for (let step = 0; step < 12; step += 1) {
    folder.apply([
      event('step/start', { turn: 0, step }, step * 10, t + step * 1_000),
    ])
    // Two token deltas at distinct timestamps make each step an observable
    // decode sample (first → message = 500 − 100 = 400 ms).
    folder.applyLiveInput(liveChunk(0, step, { type: 'text-delta', index: 0, text: 'answer' }, t + step * 1_000 + 100))
    folder.applyLiveInput(liveChunk(0, step, { type: 'text-delta', index: 0, text: ' answer' }, t + step * 1_000 + 200))
    folder.apply([
      event('assistant/message', {
        turn: 0,
        step,
        message: {
          id: MessageId(`m-bounded-${step}`),
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        usage: { inputTokens: 10, outputTokens: 100 },
        stream: [],
      }, step * 10 + 2, t + step * 1_000 + 500),
      event('step/end', { turn: 0, step }, step * 10 + 3, t + step * 1_000 + 600),
    ])
  }
  const internals = folder as unknown as { recent: { throughput: unknown[]; ttft: unknown[] } }
  assert.equal(internals.recent.throughput.length, 10, 'throughput keeps only the bounded candidate buffer (2x the window)')
  assert.equal(internals.recent.ttft.length, 5, 'a long session must not retain every TTFT sample')
  assert.equal(folder.snapshot().tokensPerSec, 250, 'derive still pools the latest FIVE valid samples (5 × 100 tok / 5 × 400 ms)')
  assert.equal(folder.snapshot().outputTokens, 1_200)
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
  assert.equal(oneShot.firstTokenMsAvg, 100)
  // The duplicate replaced the sample in place: 200 tokens over the SAME
  // 1000 ms decode span (first token → message; one sample, never two).
  assert.equal(oneShot.tokensPerSec, 200)
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
  assert.equal((folder as unknown as { settledPerStep: Map<unknown, unknown> }).settledPerStep.size, 0)
})

test('settled timing ignores a late token delta before a duplicate message', () => {
  const t = 1_700_000_000_000
  const message = (seq: number, time: number, outputTokens: number): SessionEvent => event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`m-late-delta-${seq}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 10, outputTokens },
    stream: [],
  }, seq, time)
  const log = [
    event('step/start', { turn: 0, step: 0 }, 0, t),
    // This message settles the step before any token delta was observed.
    message(1, t + 100, 100),
    // Replay artifact: a settled step must not acquire a decode start now.
    event('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: 'late' },
    }, 2, t + 200),
    message(3, t + 300, 200),
    event('step/end', { turn: 0, step: 0 }, 4, t + 400),
  ]
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  assert.equal(oneShot.llmMs, 100)
  assert.equal(oneShot.firstTokenMsAvg, 0)
  // The step settled with NO token evidence before the message: it is a
  // burst with no observable decode span, so no throughput sample exists —
  // and the late delta / duplicate message cannot create one (the late
  // delta is a replay artifact, the duplicate only swaps usage).
  assert.equal(oneShot.tokensPerSec, 0)
  assert.equal(oneShot.outputTokens, 200)
  assert.deepEqual(folder.snapshot(), oneShot)
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
  assert.equal(oneShot.tokensPerSec, 1_000)
  assert.equal(oneShot.outputTokens, 100)
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('older token deltas cannot reopen timing after a higher turn starts', () => {
  const t = 1_700_000_000_000
  const log = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t),
    event('turn/start', { turn: 1 }, 2, t + 100),
    // Both facts belong to the old open timing entry. They must not create a
    // decode window or settle a footer sample after the turn fence advanced.
    event('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: 'late' },
    }, 3, t + 200),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('m-stale-open-turn'),
        role: 'assistant',
        content: [{ type: 'text', text: 'late' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 100 },
      stream: [],
    }, 4, t + 300),
  ]
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  assert.equal(oneShot.llmMs, 0)
  assert.equal(oneShot.firstTokenMsAvg, 0)
  assert.equal(oneShot.tokensPerSec, 0)
  assert.equal(oneShot.outputTokens, 0)
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
  assert.equal(oneShot.firstTokenMsAvg, 10)
  // The replacement settled the same step in place: 300 tokens over the
  // SAME 100 ms decode span (first token → message) — one sample, never two.
  assert.equal(oneShot.tokensPerSec, 3_000)
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

test('late assistant usage after step/end replaces the sampled throughput token count', () => {
  const t = 1_700_000_000_000
  const assistantMessage = (seq: number, time: number, outputTokens: number): SessionEvent => event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`m-late-${seq}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 10, outputTokens },
    stream: [],
  }, seq, time)
  const prefix = [
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
    assistantMessage(3, t + 1_100, 100),
    event('step/end', { turn: 0, step: 0 }, 4, t + 1_200),
  ]
  const late = assistantMessage(5, t + 2_000, 200)
  const suffix = [late, event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 6, t + 2_100)]
  const oneShot = foldStats([...prefix, ...suffix])
  const folder = new StatsFolder()
  applyMixed(folder, prefix)
  assert.equal(folder.snapshot().tokensPerSec, 100)
  assert.equal((folder as unknown as { perStep: Map<unknown, unknown> }).perStep.size, 0)
  folder.apply(suffix)
  assert.equal(folder.snapshot().outputTokens, 200)
  assert.equal(folder.snapshot().tokensPerSec, 200)
  assert.deepEqual(folder.snapshot(), oneShot)
  assert.equal((folder as unknown as { settledPerStep: Map<unknown, unknown> }).settledPerStep.size, 0)
})

test('formats the DETAILED stats line: lifetime LLM beside the recent metrics', () => {
  const line = formatStats({
    turns: 2,
    steps: 2,
    llmMs: 8_100,
    firstTokenMsAvg: 1_100,
    tokensPerSec: 118,
    cacheHitPct: 93.9,
    inputTokens: 190_000,
    outputTokens: 216_000,
    cacheReadTokens: 86_000_000,
    cacheWriteTokens: 0,
    contextWindow: 1_000_000,
  })
  assert.ok(line.includes('↑190k'), line)
  assert.ok(line.includes('↓216k'), line)
  assert.ok(line.includes('R86M'), line)
  assert.ok(line.includes('CH93.9%'), line)
  // The /status detail line KEEPS the labeled lifetime wall beside the
  // recent TTFB + throughput (the footer line dropped it — that split is
  // asserted on the footer side).
  assert.ok(line.includes('LLM 8.1s'), line)
  assert.ok(line.includes('TTFB 1.1s'), line)
  assert.ok(line.includes('118 tok/s'), line)
})

test('formats the lifetime LLM wall as a readable duration at scale', () => {
  const at = (llmMs: number): string => formatStats({
    turns: 1, steps: 1, llmMs, firstTokenMsAvg: 0, tokensPerSec: 0,
    cacheHitPct: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
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

test('tok/s samples only completed steps with observable decode delivery', () => {
  const t = 1_700_000_000_000
  // Step 0: burst tool-call — a SINGLE token-bearing delta, usage, and a
  // completed message. `first == last`, so the decode span is
  // unobservable: the step must NOT enter the throughput window even
  // though it has valid usage.
  // Step 1: normal streaming — two token deltas at distinct timestamps,
  // usage, and a completed message: the only observable sample.
  // Step 2: a step that never completed (no assistant/message) — no sample.
  const log = [
    event('step/start', { turn: 0, step: 0 }, 0, t),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 10_000, cacheReadTokens: 0 } } }, 1, t + 500),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'tool-call-delta', index: 0, id: 'tc-0' as ToolCallId, name: 'bash', argumentsDelta: '{"command":"ls"}' } }, 2, t + 10_000),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('m-1'),
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'tc-0' as ToolCallId, name: 'bash', arguments: '{"command":"ls"}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 400, cacheReadTokens: 0 },
      stream: [],
    }, 3, t + 10_001),
    event('step/end', { turn: 0, step: 0 }, 4, t + 11_000),
    event('step/start', { turn: 0, step: 1 }, 5, t + 12_000),
    event('assistant/chunk', { turn: 0, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } }, 6, t + 12_100),
    event('assistant/chunk', { turn: 0, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' } }, 7, t + 12_300),
    event('assistant/message', {
      turn: 0, step: 1,
      message: {
        id: MessageId('m-2'),
        role: 'assistant',
        content: [{ type: 'text', text: 'ab' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 200, cacheReadTokens: 0 },
      stream: [],
    }, 8, t + 13_100),
    event('step/end', { turn: 0, step: 1 }, 9, t + 14_000),
    event('step/start', { turn: 0, step: 2 }, 10, t + 15_000),
    event('assistant/chunk', { turn: 0, step: 2, chunk: { type: 'text-delta', index: 0, text: 'x' } }, 11, t + 15_100),
    event('step/end', { turn: 0, step: 2 }, 12, t + 16_000),
  ]
  const stats = foldStats(log)
  // Only step 1 is observable: 200 tokens over its 1000 ms decode span
  // (first token → message) — the burst step never enters the window.
  assert.equal(stats.tokensPerSec, 200)
  // Total output includes the burst step's authoritative tokens.
  assert.equal(stats.outputTokens, 600)
})

test('normal streaming samples first token → assistant/message, not the full wall', () => {
  const t = 1_700_000_000_000
  const stats = foldStats([
    event('step/start', { turn: 0, step: 0 }, 0, t),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'a' } }, 1, t + 100),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'b' } }, 2, t + 300),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('m-decode-a'),
        role: 'assistant',
        content: [{ type: 'text', text: 'ab' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 200 },
      stream: [],
    }, 3, t + 1_100),
    event('step/end', { turn: 0, step: 0 }, 4, t + 1_200),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5, t + 1_300),
  ])
  // decodeMs = 1100 − 100 = 1000 ms → 200 tok/s. The TTFT + request
  // overhead (the first 100 ms) and the settlement tail are NOT in the
  // denominator — 200 / 1100 ms would be 181 tok/s.
  assert.equal(stats.tokensPerSec, 200)
  assert.equal(stats.firstTokenMsAvg, 100)
})

test('a single-delta burst step is skipped and never displaces valid samples', () => {
  const t = 1_700_000_000_000
  const burst = [
    event('step/start', { turn: 0, step: 0 }, 0, t),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'burst' } }, 1, t + 2_000),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('m-burst-single'),
        role: 'assistant',
        content: [{ type: 'text', text: 'burst' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 30 },
      stream: [],
    }, 2, t + 2_075),
    event('step/end', { turn: 0, step: 0 }, 3, t + 2_100),
  ]
  const alone = foldStats(burst)
  assert.equal(alone.tokensPerSec, 0, 'a single-delta burst has no observable decode span')
  assert.equal(alone.outputTokens, 30, 'the burst tokens still count in the accounting')

  // With valid samples already in the window, the burst must not overwrite,
  // occupy a slot, or change the pooled value.
  const valid = completedStep(0, 1, 4, t + 10_000, { outputTokens: 100, wallMs: 1_000 })
  const log = [...valid, ...burst]
  const stats = foldStats(log)
  assert.equal(stats.tokensPerSec, 100, 'the burst step leaves the valid sample untouched')
})

test('multiple deltas at one timestamp are skipped (adapter batch flush)', () => {
  const t = 1_700_000_000_000
  // Compact stream: three texts all stamped at time0 (dt: [0, 0]) — the
  // client cannot observe a decode span, so no throughput sample.
  const cold = computeStats([
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('m-same-stamp'),
        role: 'assistant',
        content: [{ type: 'text', text: 'abc' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 30 },
      stream: [
        { type: 'text-chunks' as const, time0: t + 1_000, index: 0, dt: [0, 0], texts: ['a', 'b', 'c'] },
      ],
    }, 2, t + 1_075),
    event('step/end', { turn: 0, step: 0 }, 3, t + 1_100),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4, t + 1_200),
  ])
  assert.equal(cold.tokensPerSec, 0, 'first == last: no observable decode span')
  assert.equal(cold.firstTokenMsAvg, 1_000, 'TTFT still uses the first token')

  // The live path with two chunks at the SAME timestamp behaves identically.
  const live = new StatsFolder()
  live.apply([
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t),
  ])
  live.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'a' }, t + 1_000))
  live.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'b' }, t + 1_000))
  live.apply([
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('m-same-stamp-live'),
        role: 'assistant',
        content: [{ type: 'text', text: 'ab' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 30 },
      stream: [],
    }, 2, t + 1_075),
    event('step/end', { turn: 0, step: 0 }, 3, t + 1_100),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4, t + 1_200),
  ])
  assert.equal(live.snapshot().tokensPerSec, 0, 'live same-timestamp deltas are equally unobservable')
})

test('tool execution wait does not affect tok/s', () => {
  const t = 1_700_000_000_000
  // Two IDENTICAL model steps (same LLM stream timing and usage) separated
  // by a SHORT tool gap vs a LONG one. The tool wait sits between
  // step/end and the next step/start — outside the decode denominator.
  const modelStep = (step: number, startTime: number, seq: number): SessionEvent[] => [
    event('step/start', { turn: 0, step }, seq, startTime),
    event('assistant/chunk', { turn: 0, step, chunk: { type: 'text-delta', index: 0, text: 'a' } }, seq + 1, startTime + 100),
    event('assistant/chunk', { turn: 0, step, chunk: { type: 'text-delta', index: 0, text: 'b' } }, seq + 2, startTime + 300),
    event('assistant/message', {
      turn: 0, step,
      message: {
        id: MessageId(`m-tool-${step}`),
        role: 'assistant',
        content: [{ type: 'text', text: 'ab' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 200 },
      stream: [],
    }, seq + 3, startTime + 1_100),
    event('step/end', { turn: 0, step }, seq + 4, startTime + 1_200),
  ]
  const shortGap = [
    ...modelStep(0, t, 0),
    ...modelStep(1, t + 1_300, 5),
  ]
  const longGap = [
    ...modelStep(0, t, 0),
    ...modelStep(1, t + 20_000, 5),
  ]
  assert.equal(foldStats(shortGap).tokensPerSec, 200)
  assert.equal(foldStats(longGap).tokensPerSec, 200, 'the tool wait never enters the decode denominator')
})

test('route reset: a burst on the new route shows 0, never the old route value', () => {
  const t = 1_700_000_000_000
  const log: SessionEvent[] = []
  let seq = 0
  // Route A establishes a valid sample.
  const stepA = completedStep(0, 0, seq, t, { provider: 'a', model: 'm', outputTokens: 100, wallMs: 1_000 })
  log.push(...stepA)
  seq += stepA.length
  // Route B's FIRST step is a burst (single delta): the window cleared
  // A's samples, and the burst is unobservable → 0 tok/s, not A's value.
  const burstB = [
    event('step/start', { turn: 0, step: 1 }, seq++, t + 10_000),
    event('assistant/chunk', { turn: 0, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'tc-b' as ToolCallId, name: 'bash', argumentsDelta: '{}' } }, seq++, t + 10_100),
    event('assistant/message', {
      turn: 0, step: 1,
      message: {
        id: MessageId('m-burst-b'),
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'tc-b' as ToolCallId, name: 'bash', arguments: '{}' }],
        source: { kind: 'model', provider: 'b', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 50 },
      stream: [],
    }, seq++, t + 10_200),
    event('step/end', { turn: 0, step: 1 }, seq++, t + 10_300),
  ]
  log.push(...burstB)
  const afterBurst = foldStats(log)
  assert.equal(afterBurst.tokensPerSec, 0, 'route B has no valid sample yet — A\'s value must not linger')
  // B's next VALID streaming step establishes B's own rate.
  const stepB = completedStep(0, 2, seq, t + 20_000, { provider: 'b', model: 'm', outputTokens: 200, wallMs: 1_000 })
  log.push(...stepB)
  const afterValid = foldStats(log)
  assert.equal(afterValid.tokensPerSec, 200, 'B\'s observable step builds the new window')
})

test('late authoritative usage cannot make a burst step valid', () => {
  const t = 1_700_000_000_000
  const message = (seq: number, time: number, outputTokens: number): SessionEvent => event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`m-burst-late-${seq}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'burst' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 10, outputTokens },
    stream: [],
  }, seq, time)
  const log = [
    event('step/start', { turn: 0, step: 0 }, 0, t),
    // A single token-bearing delta: first == last, unobservable.
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'burst' } }, 1, t + 100),
    message(2, t + 1_100, 30),
    event('step/end', { turn: 0, step: 0 }, 3, t + 1_200),
    // The late authoritative duplicate reports a much larger output.
    message(4, t + 2_000, 300),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5, t + 2_100),
  ]
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  assert.equal(oneShot.tokensPerSec, 0, 'no token count can create a sample without an observable decode span')
  assert.equal(oneShot.outputTokens, 300, 'the accounting still applies the authoritative replacement')
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('a late burst duplicate message removes the previously valid sample', () => {
  const t = 1_700_000_000_000
  const message = (seq: number, time: number, stream: AssistantStreamRecord[]): SessionEvent => event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`m-valid-then-burst-${seq}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 10, outputTokens: 100 },
    stream,
  }, seq, time)
  const log = [
    event('step/start', { turn: 0, step: 0 }, 0, t),
    // The first message settles with an OBSERVABLE decode span: 100 tokens
    // over 1100 − 100 = 1000 ms → a 100 tok/s sample.
    message(1, t + 1_100, [
      { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', index: 0, text: 'a' } },
      { type: 'chunk', time: t + 200, chunk: { type: 'text-delta', index: 0, text: 'b' } },
    ]),
    event('step/end', { turn: 0, step: 0 }, 2, t + 1_200),
    // The late authoritative duplicate's stream is a BURST (all tokens at
    // one timestamp): the authoritative evidence invalidates the range, so
    // the stale sample must leave the window — never keep reporting a
    // superseded rate.
    message(3, t + 2_000, [
      { type: 'text-chunks' as const, time0: t + 100, index: 0, dt: [0], texts: ['a', 'b'] },
    ]),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4, t + 2_100),
  ]
  const oneShot = foldStats(log)
  const cold = computeStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  assert.equal(oneShot.tokensPerSec, 0, 'the late burst evidence removes the stale sample')
  assert.equal(oneShot.outputTokens, 100, 'the accounting still applies the authoritative replacement')
  assert.equal(cold.tokensPerSec, 0, 'the cold fold removes the stale sample identically')
  assert.deepEqual(cold, oneShot, 'computeStats and StatsFolder must not diverge')
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('a late burst duplicate message WITHOUT usage still removes the stale sample', () => {
  const t = 1_700_000_000_000
  const message = (seq: number, time: number, usage: { inputTokens: number; outputTokens: number } | undefined, stream: AssistantStreamRecord[]): SessionEvent => event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`m-valid-then-burst-nousage-${seq}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    ...(usage === undefined ? {} : { usage }),
    stream,
  }, seq, time)
  const log = [
    event('step/start', { turn: 0, step: 0 }, 0, t),
    // The first message settles with an OBSERVABLE decode span and usage:
    // 100 tokens over 1100 − 100 = 1000 ms → a 100 tok/s sample.
    message(1, t + 1_100, { inputTokens: 10, outputTokens: 100 }, [
      { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', index: 0, text: 'a' } },
      { type: 'chunk', time: t + 200, chunk: { type: 'text-delta', index: 0, text: 'b' } },
    ]),
    event('step/end', { turn: 0, step: 0 }, 2, t + 1_200),
    // The late duplicate carries a BURST stream (all tokens at one
    // timestamp) and NO usage: the authoritative token evidence still
    // invalidates the range, so the stale sample must leave the window.
    message(3, t + 2_000, undefined, [
      { type: 'text-chunks' as const, time0: t + 100, index: 0, dt: [0], texts: ['a', 'b'] },
    ]),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4, t + 2_100),
  ]
  const oneShot = foldStats(log)
  const cold = computeStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  assert.equal(oneShot.tokensPerSec, 0, 'the usage-less burst duplicate still removes the stale sample')
  assert.equal(oneShot.outputTokens, 100, 'the retained usage stays authoritative')
  assert.equal(cold.tokensPerSec, 0, 'the cold fold removes the stale sample identically')
  assert.deepEqual(cold, oneShot, 'computeStats and StatsFolder must not diverge')
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('retry: a burst final success after a streamed failed attempt has no throughput sample', () => {
  const t = 1_700_000_000_000
  const events = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t),
    // The FAILED attempt streams two token deltas at distinct timestamps.
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'failed' } }, 2, t + 100),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: ' attempt' } }, 3, t + 200),
    event('assistant/attempt', { turn: 0, step: 0, stream: [] }, 4, t + 300),
    event('llm/retry-started', { retryId: 'retry-burst' as RetryId, turn: 0, step: 0, retry: 1 }, 5, t + 500),
    // The SUCCESSFUL attempt delivers a SINGLE token-bearing delta (burst).
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'ok' } }, 6, t + 5_000),
    event('assistant/message', {
      turn: 0, step: 0,
      message: { id: MessageId('m-retry-burst'), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 10, outputTokens: 200 },
      stream: [],
    }, 7, t + 6_000),
    event('step/end', { turn: 0, step: 0 }, 8, t + 6_100),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 9, t + 6_200),
  ]
  const stats = foldStats(events)
  // TTFT keeps the failed attempt's first token (100 ms)...
  assert.equal(stats.firstTokenMsAvg, 100)
  // ...but the failed attempt's token range was cleared at attempt/retry,
  // and the final burst has first == last: no throughput sample.
  assert.equal(stats.tokensPerSec, 0)
  assert.equal(stats.outputTokens, 200)
})

test('cold compact-stream fold and live transient fold agree on valid and burst steps', () => {
  const t = 1_700_000_000_000
  const boundary = (stream: AssistantStreamRecord[]): SessionEvent[] => [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('m-parity'),
        role: 'assistant',
        content: [{ type: 'text', text: 'ab' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 200 },
      stream,
    }, 2, t + 1_100),
    event('step/end', { turn: 0, step: 0 }, 3, t + 1_200),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4, t + 1_300),
  ]
  // VALID: two deltas at distinct timestamps (compact v2 text-chunks).
  const validStream = [
    { type: 'text-chunks' as const, time0: t + 100, index: 0, dt: [200], texts: ['a', 'b'] },
  ]
  const coldValid = computeStats(boundary(validStream))
  const liveValid = new StatsFolder()
  liveValid.apply(boundary([]).slice(0, 2))
  liveValid.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'a' }, t + 100))
  liveValid.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'b' }, t + 300))
  liveValid.apply(boundary([]).slice(2))
  assert.equal(coldValid.firstTokenMsAvg, 100, 'cold TTFT')
  assert.equal(liveValid.snapshot().firstTokenMsAvg, 100, 'live TTFT')
  assert.equal(coldValid.tokensPerSec, 200, 'cold decode rate (200 tok / 1000 ms)')
  assert.equal(liveValid.snapshot().tokensPerSec, 200, 'live decode rate')

  // BURST: all texts at one timestamp (dt: [0]) — both folds skip it.
  const burstStream = [
    { type: 'text-chunks' as const, time0: t + 100, index: 0, dt: [0], texts: ['a', 'b'] },
  ]
  const coldBurst = computeStats(boundary(burstStream))
  const liveBurst = new StatsFolder()
  liveBurst.apply(boundary([]).slice(0, 2))
  liveBurst.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'a' }, t + 100))
  liveBurst.applyLiveInput(liveChunk(0, 0, { type: 'text-delta', index: 0, text: 'b' }, t + 100))
  liveBurst.apply(boundary([]).slice(2))
  assert.equal(coldBurst.tokensPerSec, 0, 'cold burst is unobservable')
  assert.equal(liveBurst.snapshot().tokensPerSec, 0, 'live burst is unobservable')
  assert.equal(coldBurst.firstTokenMsAvg, 100, 'TTFT still uses the first token')
  assert.equal(liveBurst.snapshot().firstTokenMsAvg, 100)
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

test('a FAILED attempt never settles TTFT/timing in BOTH folds', () => {
  const t = 1_700_000_000_000
  const events = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 1),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } }, 2, t + 2_000),
    event('assistant/attempt', { turn: 0, step: 0, stream: [] }, 3, t + 3_000),
    event('step/end', { turn: 0, step: 0 }, 4, t + 4_000),
    event('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 5, t + 5_000),
  ]
  const stats = foldStats(events)
  assert.equal(stats.llmMs, 0, 'a failed attempt adds no LLM wall time')
  assert.equal(stats.firstTokenMsAvg, 0, 'no TTFT sample for a failed attempt')
  const folder = new StatsFolder()
  applyMixed(folder, events)
  const liveStats = folder.snapshot()
  assert.equal(liveStats.llmMs, 0)
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
  assert.equal(stats.firstTokenMsAvg, 100, 'the first token of the logical step survives the failed attempt')
  // Throughput uses ONLY the successful attempt's decode span: 9 tokens
  // over 800 − 650 = 150 ms — never the failed attempt's tokens or the
  // step/start → message wall.
  assert.equal(stats.tokensPerSec, Math.round((9 * 1000) / 150), 'throughput samples the final retry attempt, not the additive attempt total')
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
  assert.equal(stats.firstTokenMsAvg, 100)
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

test('a late assistant/attempt replacement updates recent throughput and TTFT', () => {
  const t = 1_700_000_000_000
  const usageA = { inputTokens: 10, outputTokens: 100 }
  const usageB = { inputTokens: 20, outputTokens: 200 }
  const events = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 100),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: { id: MessageId('m-performance-replacement'), role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: usageA,
      stream: [
        { type: 'chunk', time: t + 105, chunk: { type: 'text-delta', index: 0, text: 'answer' } },
        { type: 'chunk', time: t + 106, chunk: { type: 'text-delta', index: 0, text: ' answer' } },
      ],
    }, 2, t + 110),
    event('assistant/attempt', {
      turn: 0,
      step: 0,
      stream: [
        { type: 'chunk', time: t + 105, chunk: { type: 'text-delta', index: 0, text: 'late token' } },
        { type: 'chunk', time: t + 106, chunk: { type: 'usage', usage: usageB } },
      ],
    }, 3, t + 120),
    event('step/end', { turn: 0, step: 0 }, 4, t + 130),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5, t + 140),
  ]
  const oneShot = computeStats(events)
  const incremental = foldStats(events)
  for (const stats of [oneShot, incremental]) {
    assert.equal(stats.inputTokens, 20)
    assert.equal(stats.outputTokens, 200)
    assert.equal(stats.firstTokenMsAvg, 5, 'the message stream supplies the TTFT sample')
    // The late attempt's usage swaps ONLY the numerator: 200 tokens over
    // the SAME 5 ms decode span (first token → message) = 40 000 tok/s.
    assert.equal(stats.tokensPerSec, 40_000, 'late authoritative usage replaces the throughput sample numerator')
  }
})

test('a first-token-only late attempt fills TTFT but cannot create a throughput sample', () => {
  const t = 1_700_000_000_000
  const events = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 100),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: { id: MessageId('m-first-token-only'), role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 10, outputTokens: 100 },
      stream: [],
    }, 2, t + 110),
    event('assistant/attempt', {
      turn: 0,
      step: 0,
      stream: [{ type: 'chunk', time: t + 105, chunk: { type: 'text-delta', index: 0, text: 'late token' } }],
    }, 3, t + 120),
    event('step/end', { turn: 0, step: 0 }, 4, t + 130),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5, t + 140),
  ]
  const oneShot = computeStats(events)
  const incremental = foldStats(events)
  for (const stats of [oneShot, incremental]) {
    assert.equal(stats.inputTokens, 10)
    assert.equal(stats.outputTokens, 100)
    assert.equal(stats.firstTokenMsAvg, 5, 'late attempt first-token evidence fills the missing TTFT sample')
    // The step settled with NO token evidence (burst): the late attempt's
    // single token fills TTFT but cannot create a decode span — a burst
    // final response stays out of the throughput window.
    assert.equal(stats.tokensPerSec, 0)
  }
  assert.deepEqual(incremental, oneShot)
})

test('a late assistant/attempt after step/end replaces the retained throughput sample', () => {
  const t = 1_700_000_000_000
  const events = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 100),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: { id: MessageId('m-post-step-performance'), role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 10, outputTokens: 100 },
      stream: [
        { type: 'chunk', time: t + 105, chunk: { type: 'text-delta', index: 0, text: 'answer' } },
        { type: 'chunk', time: t + 106, chunk: { type: 'text-delta', index: 0, text: ' answer' } },
      ],
    }, 2, t + 110),
    event('step/end', { turn: 0, step: 0 }, 3, t + 120),
    event('assistant/attempt', {
      turn: 0,
      step: 0,
      stream: [{ type: 'chunk', time: t + 115, chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 200 } } }],
    }, 4, t + 130),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5, t + 140),
  ]
  const oneShot = computeStats(events)
  const incremental = foldStats(events)
  // 200 tokens over the retained 5 ms decode span = 40 000 tok/s.
  assert.equal(oneShot.tokensPerSec, 40_000)
  assert.equal(incremental.tokensPerSec, 40_000)
  assert.deepEqual(incremental, oneShot)
})

test('duplicate late attempts replace and can invalidate the throughput sample', () => {
  const t = 1_700_000_000_000
  const prefix = [
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t + 100),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: { id: MessageId('m-duplicate-attempt-performance'), role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 10, outputTokens: 100 },
      stream: [
        { type: 'chunk', time: t + 105, chunk: { type: 'text-delta', index: 0, text: 'answer' } },
        { type: 'chunk', time: t + 106, chunk: { type: 'text-delta', index: 0, text: ' answer' } },
      ],
    }, 2, t + 110),
  ]
  const replacement = event('assistant/attempt', {
    turn: 0,
    step: 0,
    stream: [{ type: 'chunk', time: t + 105, chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 200 } } }],
  }, 3, t + 120)
  const invalidation = event('assistant/attempt', {
    turn: 0,
    step: 0,
    stream: [{ type: 'chunk', time: t + 106, chunk: { type: 'usage', usage: { inputTokens: 30, outputTokens: 0 } } }],
  }, 4, t + 130)
  const suffix = [
    invalidation,
    event('step/end', { turn: 0, step: 0 }, 5, t + 140),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 6, t + 150),
  ]
  const oneShot = computeStats([...prefix, replacement, ...suffix])
  const folder = new StatsFolder()
  folder.apply(prefix)
  folder.apply([replacement])
  assert.equal(folder.snapshot().outputTokens, 200)
  // 200 tokens over the retained 5 ms decode span = 40 000 tok/s.
  assert.equal(folder.snapshot().tokensPerSec, 40_000)
  folder.apply(suffix)
  assert.equal(folder.snapshot().inputTokens, 30)
  assert.equal(folder.snapshot().outputTokens, 0)
  assert.equal(folder.snapshot().tokensPerSec, 0)
  assert.deepEqual(folder.snapshot(), oneShot)
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

test('recent-5 throughput pools the latest five steps and evicts the first (Σoutput / ΣdecodeMs)', () => {
  const t = 1_700_000_000_000
  // Six 1-token-per-second steps: the 6th completes → the 1st leaves the
  // window; TPS = Σ(step2..step6 output) / Σ(step2..step6 decodeMs).
  const log: SessionEvent[] = []
  let seq = 0
  for (let step = 0; step < 6; step += 1) {
    const events = completedStep(0, step, seq, t + step * 10_000, { outputTokens: 1_000, wallMs: 1_000 })
    log.push(...events)
    seq += events.length
  }
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  // Five steps × 1000 tokens over five 1s walls = 1000 tok/s.
  assert.equal(oneShot.tokensPerSec, 1_000)
  assert.deepEqual(folder.snapshot(), oneShot)
  // Hard gate: cold and incremental folds agree at EVERY suffix boundary.
  const probe = new StatsFolder()
  for (let index = 0; index < log.length; index += 1) {
    applyMixed(probe, [log[index]!])
    assert.deepEqual(probe.snapshot(), foldStats(log.slice(0, index + 1)), `parity after event ${index}`)
  }
})

test('burst steps never occupy a recent-5 valid sample slot', () => {
  const t = 1_700_000_000_000
  // Five valid streaming steps establish a stable rate, then several burst
  // tool-call steps (a SINGLE token-bearing delta each — unobservable)
  // must not displace them: the window pools the latest 5 VALID samples.
  const log: SessionEvent[] = []
  let seq = 0
  for (let step = 0; step < 5; step += 1) {
    const events = completedStep(0, step, seq, t + step * 10_000, { outputTokens: 100, wallMs: 1_000 })
    log.push(...events)
    seq += events.length
  }
  const burst = (step: number, startTime: number): SessionEvent[] => [
    event('step/start', { turn: 0, step }, seq++, startTime),
    event('assistant/chunk', {
      turn: 0,
      step,
      chunk: { type: 'tool-call-delta', index: 0, id: `tc-${step}` as ToolCallId, name: 'bash', argumentsDelta: '{"command":"ls"}' },
    }, seq++, startTime + 1_900),
    event('assistant/message', {
      turn: 0,
      step,
      message: {
        id: MessageId(`m-burst-${step}`),
        role: 'assistant',
        content: [{ type: 'tool-call', id: `tc-${step}` as ToolCallId, name: 'bash', arguments: '{"command":"ls"}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 400 },
      stream: [],
    }, seq++, startTime + 2_000),
    event('step/end', { turn: 0, step }, seq++, startTime + 2_100),
  ]
  for (let step = 5; step < 8; step += 1) log.push(...burst(step, t + step * 5_000))
  const afterBurst = foldStats(log)
  assert.equal(afterBurst.tokensPerSec, 100, 'burst steps do not enter the window: the five valid samples still pool 5 × 100 tok / 5 s')
  // A new VALID step evicts the OLDEST valid sample (not a burst): the
  // rolling value updates normally.
  const newest = completedStep(0, 8, seq, t + 50_000, { outputTokens: 200, wallMs: 1_000 })
  log.push(...newest)
  const afterNew = foldStats(log)
  assert.equal(afterNew.tokensPerSec, Math.round((4 * 100 + 200) * 1000 / 5_000), 'the newest valid step evicts the oldest valid one')
})

test('recent TTFB averages the latest five first-token steps', () => {
  const t = 1_700_000_000_000
  const log: SessionEvent[] = []
  let seq = 0
  for (let step = 0; step < 6; step += 1) {
    const events = completedStep(0, step, seq, t + step * 10_000, {
      outputTokens: 10,
      wallMs: 500,
      firstDeltaMs: 100 * (step + 1),
    })
    log.push(...events)
    seq += events.length
  }
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  // Latest five first-token deltas: 200..600 ms → mean 400 ms.
  assert.equal(oneShot.firstTokenMsAvg, 400)
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('late attempt TTFT keeps its completion ordinal and recent-five membership', () => {
  const t = 1_700_000_000_000
  const log: SessionEvent[] = []
  let seq = 0
  const first = completedStep(0, 0, seq, t, { tokenDeltas: false })
  log.push(...first)
  seq += first.length
  for (let step = 1; step <= 4; step += 1) {
    const events = completedStep(0, step, seq, t + step * 10_000, { firstDeltaMs: step * 100 })
    log.push(...events)
    seq += events.length
  }
  const folder = new StatsFolder()
  applyMixed(folder, log)
  const late = event('assistant/attempt', {
    turn: 0,
    step: 0,
    stream: [{ type: 'chunk', time: t + 50, chunk: { type: 'text-delta', index: 0, text: 'late first token' } }],
  }, seq++, t + 50)
  applyMixed(folder, [late])
  const internals = folder as unknown as { recent: { ttft: Array<{ key: string; ordinal: number; ttftMs: number }> } }
  const repaired = internals.recent.ttft.find(sample => sample.key === '0/0')
  assert.ok(repaired !== undefined)
  assert.equal(repaired.ordinal, 0, 'late evidence must retain the original completion ordinal')
  assert.equal(repaired.ttftMs, 50)

  const newest = completedStep(0, 5, seq, t + 50_000, { firstDeltaMs: 500 })
  applyMixed(folder, newest)
  // The late step 0 sample is now outside the latest-five window; an
  // incorrectly appended late sample would evict step 1 instead and change
  // this average.
  assert.equal(folder.snapshot().firstTokenMsAvg, 300)
})

test('late attempt TTFT cannot resurrect a sample across A → B → A route epochs', () => {
  const t = 1_700_000_000_000
  const stepA0 = completedStep(0, 0, 0, t, { provider: 'a', model: 'm' })
  const stepB = completedStep(0, 1, stepA0.length, t + 10_000, {
    provider: 'b', model: 'm', firstDeltaMs: 100,
  })
  const stepA1 = completedStep(0, 2, stepA0.length + stepB.length, t + 20_000, {
    provider: 'a', model: 'm', firstDeltaMs: 200,
  })
  const late = event('assistant/attempt', {
    turn: 0,
    step: 0,
    stream: [{ type: 'chunk', time: t + 30_000, chunk: { type: 'text-delta', index: 0, text: 'old route token' } }],
  }, stepA0.length + stepB.length + stepA1.length, t + 30_000)
  const folder = new StatsFolder()
  applyMixed(folder, [...stepA0, ...stepB, ...stepA1, late])
  // Only the second A lifecycle's 200ms sample belongs to the current
  // performance window; the old A step remains an accounting fact only.
  assert.equal(folder.snapshot().firstTokenMsAvg, 200)
})

test('a model/provider route change resets the recent performance window', () => {
  const t = 1_700_000_000_000
  const log: SessionEvent[] = []
  let seq = 0
  for (let step = 0; step < 5; step += 1) {
    const events = completedStep(0, step, seq, t + step * 10_000, {
      provider: 'a', model: 'slow', outputTokens: 1_000, wallMs: 5_000, firstDeltaMs: 4_000,
    })
    log.push(...events)
    seq += events.length
  }
  const switchEvents = completedStep(0, 5, seq, t + 50_000, {
    provider: 'b', model: 'fast', outputTokens: 100, wallMs: 1_100, firstDeltaMs: 100,
  })
  log.push(...switchEvents)
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log.slice(0, log.length - switchEvents.length))
  // Route A: 5 × 1000 tokens over 5 × 1000 ms decode spans (first token
  // at 4000 → message at 5000) = 1000 tok/s.
  assert.equal(folder.snapshot().tokensPerSec, 1_000, 'before the switch the window is route A')
  assert.equal(folder.snapshot().firstTokenMsAvg, 4_000)
  applyMixed(folder, switchEvents)
  // After B's first completed response the window holds ONLY B's sample.
  assert.deepEqual(folder.snapshot(), oneShot)
  assert.equal(folder.snapshot().tokensPerSec, 100)
  assert.equal(folder.snapshot().firstTokenMsAvg, 100)
  // The lifetime LLM wall and the usage totals keep accumulating.
  assert.equal(folder.snapshot().llmMs, 5 * 5_000 + 1_100)
  assert.equal(folder.snapshot().outputTokens, 5_100)
})

test('route keys are delimiter-safe (provider/model containing "/" never collide)', () => {
  const t = 1_700_000_000_000
  // ("a/b", "c") vs ("a", "b/c"): a naive `provider + '/' + model`
  // concatenation collapses BOTH routes to "a/b/c" and the switch goes
  // undetected — the window would pool both steps (1100 tokens / 6 s ≈
  // 183 tok/s, TTFB mean 2050). The tuple-encoded key must reset.
  const stepA = completedStep(0, 0, 0, t, { provider: 'a/b', model: 'c', outputTokens: 1_000, wallMs: 5_000, firstDeltaMs: 4_000 })
  const stepB = completedStep(0, 1, stepA.length, t + 10_000, { provider: 'a', model: 'b/c', outputTokens: 100, wallMs: 1_100, firstDeltaMs: 100 })
  const log = [...stepA, ...stepB]
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  assert.equal(folder.snapshot().tokensPerSec, 100, 'the delimiter-ambiguous switch must still reset the window')
  assert.equal(folder.snapshot().firstTokenMsAvg, 100)
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('a late usage replacement cannot resurrect a sample after a route reset', () => {
  const t = 1_700_000_000_000
  const log: SessionEvent[] = []
  let seq = 0
  const stepA = completedStep(0, 0, seq, t, { provider: 'a', model: 'm', outputTokens: 100, wallMs: 1_000 })
  log.push(...stepA)
  seq += stepA.length
  // Route B settles → the window clears A's sample.
  const stepB = completedStep(0, 1, seq, t + 10_000, { provider: 'b', model: 'm', outputTokens: 100, wallMs: 1_000 })
  log.push(...stepB)
  seq += stepB.length
  // A late duplicate of the OLD-route step must not re-insert its sample.
  const late = event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId('m-late-old-route'),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'a', model: 'm' },
    },
    usage: { inputTokens: 10, outputTokens: 9_999 },
    stream: [],
  }, seq++, t + 20_000)
  log.push(late)
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  assert.equal(oneShot.tokensPerSec, 100, 'only route B\'s sample remains')
  assert.equal(oneShot.outputTokens, 10_099, 'the token ACCOUNTING still applies the authoritative replacement')
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('a late attempt cannot resurrect a sample across A → B → A route epochs', () => {
  const t = 1_700_000_000_000
  const stepA0 = completedStep(0, 0, 0, t, { provider: 'a', model: 'm', outputTokens: 100, wallMs: 1_000 })
  const stepB = completedStep(0, 1, stepA0.length, t + 10_000, { provider: 'b', model: 'm', outputTokens: 100, wallMs: 1_000 })
  const stepA1 = completedStep(0, 2, stepA0.length + stepB.length, t + 20_000, { provider: 'a', model: 'm', outputTokens: 100, wallMs: 1_000 })
  const late = event('assistant/attempt', {
    turn: 0,
    step: 0,
    stream: [{ type: 'chunk', time: t + 30_000, chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 9_999 } } }],
  }, stepA0.length + stepB.length + stepA1.length, t + 30_000)
  const log = [...stepA0, ...stepB, ...stepA1, late]
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  assert.equal(oneShot.tokensPerSec, 100)
  assert.equal(oneShot.outputTokens, 10_199)
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('a usage-less step that becomes valid via a late authoritative message joins at its original ordinal', () => {
  const t = 1_700_000_000_000
  const log: SessionEvent[] = []
  let seq = 0
  for (let step = 0; step < 2; step += 1) {
    // Steps 0-1 settle WITHOUT usage (no sample yet), but with an
    // OBSERVABLE decode span (two token deltas at distinct timestamps) so
    // a late authoritative usage can still create their samples.
    const events: SessionEvent[] = [
      event('step/start', { turn: 0, step }, seq++, t + step * 10_000),
      event('assistant/chunk', {
        turn: 0,
        step,
        chunk: { type: 'text-delta', index: 0, text: 'answer' },
      }, seq++, t + step * 10_000 + 100),
      event('assistant/chunk', {
        turn: 0,
        step,
        chunk: { type: 'text-delta', index: 0, text: ' answer' },
      }, seq++, t + step * 10_000 + 200),
      event('assistant/message', {
        turn: 0,
        step,
        message: {
          id: MessageId(`m-nousage-${step}`),
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        stream: [],
      }, seq++, t + step * 10_000 + 1_100),
      event('step/end', { turn: 0, step }, seq++, t + step * 10_000 + 1_200),
    ]
    log.push(...events)
  }
  // Step 2 settles WITH usage (a real sample, ordinal 2).
  const step2 = completedStep(0, 2, seq, t + 20_000, { outputTokens: 300, wallMs: 1_000 })
  log.push(...step2)
  seq += step2.length
  // A late authoritative duplicate gives step 1 its usage: it must join
  // the window at its ORIGINAL completion ordinal, not as the newest.
  const late = event('assistant/message', {
    turn: 0,
    step: 1,
    message: {
      id: MessageId('m-nousage-1-late'),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 10, outputTokens: 900 },
    stream: [],
  }, seq++, t + 30_000)
  log.push(late)
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log.slice(0, -1))
  // Before the late message: one sample (step 2: 300 tokens / 1 s).
  assert.equal(folder.snapshot().tokensPerSec, 300)
  folder.apply([late])
  assert.deepEqual(folder.snapshot(), oneShot)
  // Samples: step1 (900 tokens over its 1000 ms decode span, ordinal 1) +
  // step2 (300 tokens over 1000 ms) → pooled 1200 tokens / 2 s = 600
  // tok/s — the old step joined mid-window at its original ordinal.
  assert.equal(oneShot.tokensPerSec, 600)
})

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
  assert.equal(stats.tokensPerSec, 4_000)
  // Usage accounting is untouched by the performance window.
  assert.equal(stats.outputTokens, 3_200)
  assert.equal(stats.steps, 8)
  assert.deepEqual(folder.snapshot(), stats)
})

test('cancelled and failed steps contribute no recent performance samples', () => {
  const t = 1_700_000_000_000
  const prefix: SessionEvent[] = []
  let seq = 0
  for (let step = 0; step < 3; step += 1) {
    const events = completedStep(0, step, seq, t + step * 10_000, { outputTokens: 100, wallMs: 1_000 })
    prefix.push(...events)
    seq += events.length
  }
  // A cancelled step: start, a delta, step/end — never a message.
  const cancelled: SessionEvent[] = [
    event('step/start', { turn: 0, step: 3 }, seq++, t + 30_000),
    event('assistant/chunk', {
      turn: 0,
      step: 3,
      chunk: { type: 'text-delta', index: 0, text: 'partial' },
    }, seq++, t + 30_100),
    event('step/end', { turn: 0, step: 3 }, seq++, t + 35_000),
  ]
  const log = [...prefix, ...cancelled]
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  assert.equal(oneShot.tokensPerSec, 100)
  assert.equal(oneShot.firstTokenMsAvg, 0)
  assert.deepEqual(folder.snapshot(), oneShot)
})

test('an authoritative duplicate that invalidates the sample REMOVES it (no stale throughput)', () => {
  const t = 1_700_000_000_000
  const message = (seq: number, time: number, outputTokens: number | undefined): SessionEvent => event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`m-invalidate-${seq}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    ...(outputTokens === undefined ? {} : { usage: { inputTokens: 10, outputTokens } }),
    stream: [],
  }, seq, time)
  const prefix = [
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
    message(3, t + 1_100, 100),
    event('step/end', { turn: 0, step: 0 }, 4, t + 1_200),
  ]
  // The authoritative duplicate corrects outputTokens to 0: the step's
  // sample is no longer valid and must not keep feeding the recent rate.
  const invalidating = message(5, t + 2_000, 0)
  const log = [...prefix, invalidating]
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, prefix)
  assert.equal(folder.snapshot().tokensPerSec, 100, 'the valid sample rides the window first')
  folder.apply([invalidating])
  assert.deepEqual(folder.snapshot(), oneShot)
  assert.equal(folder.snapshot().tokensPerSec, 0, 'the invalidated sample leaves the window')
  // Timing facts survive the correction untouched.
  assert.equal(folder.snapshot().llmMs, 1_100)
  assert.equal(folder.snapshot().firstTokenMsAvg, 100)
  // The usage accounting applied the authoritative replacement.
  assert.equal(folder.snapshot().outputTokens, 0)

  // The stale-denominator repro: a SECOND valid step after the
  // invalidation must pool over its own decode span only. Keeping A's
  // decode span (the lifetime-style subtract-only variant → 300 tokens /
  // 2 s = 150) or keeping A's sample whole (the unremoved variant → 400
  // tokens / 2 s = 200) both miss; the correct removal yields 300 tok/s.
  const stepB = completedStep(0, 1, 6, t + 10_000, { outputTokens: 300, wallMs: 1_000 })
  const withB = [...prefix, invalidating, ...stepB]
  const oneShotWithB = foldStats(withB)
  const folderB = new StatsFolder()
  applyMixed(folderB, prefix)
  applyMixed(folderB, [invalidating, ...stepB])
  assert.equal(folderB.snapshot().tokensPerSec, 300, `the invalidated wall must not ride the window:\n${JSON.stringify(folderB.snapshot())}`)
  assert.deepEqual(folderB.snapshot(), oneShotWithB)

  // A LATER VALID duplicate of the invalidated step re-inserts its sample
  // at the ORIGINAL completion ordinal (0 → 500: pooled with B = 400).
  const revalid = message(9, t + 20_000, 500)
  folderB.apply([revalid])
  assert.deepEqual(folderB.snapshot(), foldStats([...withB, revalid]))
  assert.equal(folderB.snapshot().tokensPerSec, 400, 'the re-validated step rejoins the pooled window')
})

test('a route STRING match is not enough: A → B → A cannot resurrect the first A\'s sample', () => {
  const t = 1_700_000_000_000
  const log: SessionEvent[] = []
  let seq = 0
  const push = (events: SessionEvent[]): void => {
    log.push(...events)
    seq += events.length
  }
  // Epoch 0: route A settles a big sample.
  push(completedStep(0, 0, seq, t, { provider: 'p', model: 'a', outputTokens: 1_000, wallMs: 1_000 }))
  // Epoch 1: route B resets the window.
  push(completedStep(0, 1, seq, t + 10_000, { provider: 'p', model: 'b', outputTokens: 100, wallMs: 1_000 }))
  // Epoch 2: route A AGAIN — the route string equals epoch 0's, but this
  // is a NEW route lifecycle with a fresh window.
  push(completedStep(0, 2, seq, t + 20_000, { provider: 'p', model: 'a', outputTokens: 200, wallMs: 1_000 }))
  // A late authoritative duplicate of the OLD A step: its route string
  // matches the current window's — only the epoch gate must keep it out.
  const late = event('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId('m-old-a-epoch'),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'a' },
    },
    usage: { inputTokens: 10, outputTokens: 9_999 },
    stream: [],
  }, seq, t + 30_000)
  log.push(late)
  const oneShot = foldStats(log)
  const folder = new StatsFolder()
  applyMixed(folder, log)
  // Only the SECOND A lifecycle's sample rides the window: 200 tok/s.
  assert.equal(oneShot.tokensPerSec, 200, `the epoch gate must hold:\n${JSON.stringify(oneShot)}`)
  assert.deepEqual(folder.snapshot(), oneShot)
  // The token ACCOUNTING still applies the authoritative replacement.
  assert.equal(oneShot.outputTokens, 10_299)
})

test('invalidating one of the latest five BACKFILLS the next-older candidate', () => {
  const t = 1_700_000_000_000
  const log: SessionEvent[] = []
  let seq = 0
  const push = (events: SessionEvent[]): void => {
    log.push(...events)
    seq += events.length
  }
  // Six same-route valid samples: 0 = 1000 tok / 1s, 1..5 = 100 tok / 1s.
  push(completedStep(0, 0, seq, t, { outputTokens: 1_000, wallMs: 1_000 }))
  for (let step = 1; step <= 5; step += 1) {
    push(completedStep(0, step, seq, t + step * 10_000, { outputTokens: 100, wallMs: 1_000 }))
  }
  const folder = new StatsFolder()
  applyMixed(folder, log)
  assert.equal(folder.snapshot().tokensPerSec, 100, 'the sixth completion evicts sample 0 from the derived window')
  // An authoritative duplicate invalidates the NEWEST sample (ordinal 5):
  // the window's contract is "latest 5 VALID samples", so ordinal 0 —
  // still retained as a candidate — must BACKFILL: (1000 + 4x100) / 5 s.
  const invalidating = event('assistant/message', {
    turn: 0,
    step: 5,
    message: {
      id: MessageId('m-backfill-invalidate'),
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 10, outputTokens: 0 },
    stream: [],
  }, seq++, t + 100_000)
  log.push(invalidating)
  const oneShot = foldStats(log)
  folder.apply([invalidating])
  assert.equal(folder.snapshot().tokensPerSec, 280, `the evicted candidate must backfill:\n${JSON.stringify(folder.snapshot())}`)
  assert.deepEqual(folder.snapshot(), oneShot)
  assert.equal(folder.snapshot().outputTokens, 1_400, 'the accounting applies the authoritative zero')
})
