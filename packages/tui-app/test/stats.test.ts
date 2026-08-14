/**
 * Unit tests for session statistics folding: timing, tokens, cache rate,
 * and the pi-vocabulary stats line.
 * @module @dsh-pi-tui/tui-app/stats.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId } from '@deepseek-ai/dsh-llm'
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
    event('step/end', { turn: 0, step: 0 }, 4, t + 8_100),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5, t + 8_200),
  ])
  assert.equal(stats.turns, 1)
  assert.equal(stats.steps, 1)
  assert.equal(stats.llmMs, 8_100)
  assert.equal(stats.firstTokenMsAvg, 1_100)
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
