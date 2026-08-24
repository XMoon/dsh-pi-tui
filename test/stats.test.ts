/**
 * Unit tests for session statistics folding: timing, tokens, cache rate,
 * and the pi-vocabulary stats line.
 * @module @xmoon76/dsh-pi-tui/stats.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId, type CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { computeStats, formatStats, StatsFolder } from '../src/stats.ts'
import { StepUsageAccumulator } from '../src/token-usage.ts'
import { TranscriptFolder } from '../src/transcript.ts'

/** Build a minimal event envelope for tests. */
function event<K extends SessionEvent['type']>(
  type: K,
  data: SessionEvent<K>['data'],
  seq: number,
  time = 1_700_000_000_000 + seq * 1000,
): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

test('computes turns, steps, LLM time, and first-token latency', () => {
  const t = 1_700_000_000_000
  const stats = computeStats([
    event('turn/start', { turn: 0 }, 0, t),
    event('step/start', { turn: 0, step: 0 }, 1, t),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } }, 2, t + 1_100),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: ' there' } }, 3, t + 2_000),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('m-1'),
        role: 'assistant',
        content: [{ type: 'text', text: 'hi there' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, 4, t + 8_000),
    event('step/end', { turn: 0, step: 0 }, 5, t + 8_100),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 6, t + 8_200),
  ])
  assert.equal(stats.turns, 1)
  assert.equal(stats.steps, 1)
  // LLM wall time ends at assistant/message, never at step/end (Web parity).
  assert.equal(stats.llmMs, 8_000)
  assert.equal(stats.firstTokenMsAvg, 1_100)
})

test('a step without an assistant message contributes no timing (Web parity)', () => {
  const t = 1_700_000_000_000
  const stats = computeStats([
    event('step/start', { turn: 0, step: 0 }, 0, t),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } }, 1, t + 1_000),
    // Cancelled/failed: step/end arrives, the message never does.
    event('step/end', { turn: 0, step: 0 }, 2, t + 5_000),
  ])
  assert.equal(stats.steps, 1, 'steps count at step/end')
  assert.equal(stats.turns, 1, 'turns count at step/end (unique)')
  assert.equal(stats.llmMs, 0, 'no message means no wall time')
  assert.equal(stats.firstTokenMsAvg, 0, 'no message means no TTFT')
  assert.equal(stats.tokensPerSec, 0)
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
    }, 3, t + 5_000),
    event('step/end', { turn: 0, step: 0 }, 4, t + 6_000),
    // Step 1: tool-call delta only, then usage — also a token delta start.
    event('step/start', { turn: 1, step: 0 }, 5, t + 7_000),
    event('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'tool-call-delta', index: 0, id: 'tc-1' as CallId, name: 'bash', argumentsDelta: '{"command"' } }, 6, t + 7_100),
    event('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: MessageId('m-2'),
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'tc-1' as CallId, name: 'bash', arguments: '{"command":"ls"}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 50, cacheReadTokens: 0 },
    }, 7, t + 7_600),
    event('step/end', { turn: 1, step: 0 }, 8, t + 8_000),
  ]
  const stats = computeStats(log)
  // Step 0: 450 tokens / 4500 ms = 100 tok/s. Step 1: 50 / 500 ms = 100.
  assert.equal(stats.tokensPerSec, 100, `decode window must start at the first reasoning delta:\n${JSON.stringify(stats)}`)
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
    }, 0),
  ])
  assert.equal(stats.inputTokens, 9_000)
  assert.equal(stats.outputTokens, 832)
  assert.equal(stats.cacheHitPct, 10)
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
  const oneShot = computeStats(log)
  // Incremental fold: every suffix boundary must agree with the one-shot
  // result for the events applied so far.
  const folder = new StatsFolder()
  for (let index = 0; index < log.length; index += 1) {
    folder.apply([log[index]!])
    const partial = computeStats(log.slice(0, index + 1))
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

test('formats the stats line in pi abbreviation vocabulary', () => {
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
  assert.ok(line.includes('LLM 8.1s'), line)
  assert.ok(line.includes('TTFB 1.1s'), line)
  assert.ok(line.includes('118 tok/s'), line)
})

test('usage is counted once per step despite chunk and message both carrying it', () => {
  const t = 1_700_000_000_000
  const stats = computeStats([
    event('step/start', { turn: 0, step: 0 }, 0, t),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 9_000, outputTokens: 832, cacheReadTokens: 1_000 } } }, 1, t + 1_000),
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
    }, 2, t + 2_000),
    event('step/end', { turn: 0, step: 0 }, 3, t + 3_000),
  ])
  // The same assembler usage rides both events; adding both would double it.
  assert.equal(stats.inputTokens, 9_000)
  assert.equal(stats.outputTokens, 832)
  assert.equal(stats.cacheReadTokens, 1_000)
  assert.equal(stats.cacheHitPct, 10)
})

test('tok/s samples only steps carrying both a decode window and usage', () => {
  const t = 1_700_000_000_000
  // Step 0: reasoning only — usage but no text delta (must not inflate tok/s).
  // Step 1: decode + usage — the only sampled pair.
  // Step 2: decode but no usage (must not enter the denominator alone).
  const log = [
    event('step/start', { turn: 0, step: 0 }, 0, t),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 10_000, cacheReadTokens: 0 } } }, 1, t + 500),
    event('step/end', { turn: 0, step: 0 }, 2, t + 5_000),
    event('step/start', { turn: 0, step: 1 }, 3, t + 6_000),
    event('assistant/chunk', { turn: 0, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } }, 4, t + 6_100),
    event('assistant/chunk', { turn: 0, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' } }, 5, t + 6_200),
    event('assistant/message', {
      turn: 0, step: 1,
      message: {
        id: MessageId('m-2'),
        role: 'assistant',
        content: [{ type: 'text', text: 'ab' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 500, cacheReadTokens: 0 },
    }, 6, t + 7_000),
    event('step/end', { turn: 0, step: 1 }, 7, t + 8_000),
    event('step/start', { turn: 0, step: 2 }, 8, t + 9_000),
    event('assistant/chunk', { turn: 0, step: 2, chunk: { type: 'text-delta', index: 0, text: 'x' } }, 9, t + 9_100),
    event('assistant/chunk', { turn: 0, step: 2, chunk: { type: 'text-delta', index: 0, text: 'y' } }, 10, t + 9_200),
    event('step/end', { turn: 0, step: 2 }, 11, t + 10_000),
  ]
  const stats = computeStats(log)
  // Step 1: 500 tokens over (7000 - 6100) = 900 ms → 555 tok/s.
  assert.equal(stats.tokensPerSec, Math.round(500 / 0.9))
  // Total output includes the reasoning-only step (10_000 + 500).
  assert.equal(stats.outputTokens, 10_500)
  // The decode end uses the assistant/message time, not the last delta
  // (6100→7000 window above proves it: last delta was at 6200).
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
  const stats = computeStats(events)
  const folder = new TranscriptFolder()
  folder.apply(events)
  assert.equal(stats.inputTokens, 100, 'the delayed prior-turn fact must be stale')
  assert.equal(folder.turnActivity(0)!.totalTokens, 100, 'the Focus per-turn total must agree with the footer')
})

test('turn/end drops the open timing entries of the ended turn', () => {
  const folder = new StatsFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } }, 2),
    // turn/end arrives while the step is still open (interrupted).
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
  const stats = computeStats(events)
  const folder = new TranscriptFolder()
  folder.apply(events)
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
    // A late usage chunk (replay artifact): both folds must ignore it.
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 200, outputTokens: 0 } } }, 5, t + 5),
  ]
  const stats = computeStats(events)
  const folder = new TranscriptFolder()
  folder.apply(events)
  assert.equal(stats.inputTokens, 100, 'the footer must ignore the late usage chunk')
  assert.equal(folder.turnActivity(0)!.totalTokens, 100, 'the Focus per-turn total must agree with the footer')
})

test('a duplicate step/start never leaks the open step pending usage', () => {
  const acc = new StepUsageAccumulator()
  acc.onStepStart(0, 0)
  acc.onUsageChunk(0, 0, { inputTokens: 100, outputTokens: 0 })
  acc.onStepStart(0, 0) // duplicate
  acc.onStepEnd(0, 0)
  assert.equal(acc.sessionTotals().inputTokens, 100, 'the duplicate start must not lose the pending usage')
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
    event('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } }, 1),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('m-1'),
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
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
    }, 1, t + 2_000),
    // A long tool run after the message must not extend the LLM wall time.
    event('step/end', { turn: 0, step: 0 }, 2, t + 9_000),
  ])
  assert.equal(stats.llmMs, 2_000)
})
