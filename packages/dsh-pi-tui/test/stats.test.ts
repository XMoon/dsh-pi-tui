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
