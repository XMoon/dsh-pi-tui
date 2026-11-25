/**
 * L1 contract tests for the Session Inspector detached projection.
 *
 * The mapper answers ONE semantic question: what does this exact official
 * projection cut legally say about the selected Session? These cases pin the
 * fixed Inspector semantics (whole-log stats, disjoint token buckets, the
 * approximate context occupancy and the existing detached status fields) and
 * their "missing is not zero / malformed is not a value" boundaries. They do
 * not exercise a backend adapter or a real Client/Host wire.
 *
 * @module @xmoon76/dsh-pi-tui/session-inspector-projection.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detachSessionInspector,
  INSPECTOR_PROJECTION_KEYS,
  type SessionInspectorData,
} from '../../src/runtime/session-inspector-projection.ts'

const SESSION = 'session-inspector-fixture'

const fullStats = {
  turns: 2,
  steps: 3,
  llmMs: 3000,
  toolMs: 700,
  ttftMs: 600,
  ttftSteps: 2,
  decodeMs: 1500,
  decodeTokens: 120,
}

const fullUsage = {
  uncachedInputTokens: 10,
  outputTokens: 40,
  cacheReadTokens: 70,
  cacheWriteTokens: 20,
}

function fixture(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    sessionStats: fullStats,
    tokenUsage: fullUsage,
    contextPressure: { projectedTokens: 0, pressureTokens: 999, contextWindow: 100 },
    modelSelection: { next: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' }, lastUsed: undefined },
    agentPreset: 'reviewer',
    title: 'Inspector fixture',
    workingDirectory: '/host/project',
    goal: { goal: { objective: 'finish PR2', phase: 'active' } },
    todos: [
      { content: 'one', status: 'pending' },
      { content: 'two', status: 'in_progress' },
      { content: 'three', status: 'completed' },
      { content: 'four', status: 'pending' },
    ],
    ...overrides,
  }
}

test('INSPECTOR-01 the full legal cut maps every fixed Inspector field with its exact derived semantics', () => {
  const data = detachSessionInspector(SESSION, 42, fixture())
  assert.deepEqual(data, {
    sessionId: SESSION,
    asOfSeq: 42,
    stats: {
      turns: 2,
      steps: 3,
      llmMs: 3000,
      toolMs: 700,
      avgTtftMs: 300,
      decodeTokensPerSec: 80,
    },
    usage: {
      uncachedInputTokens: 10,
      outputTokens: 40,
      cacheReadTokens: 70,
      cacheWriteTokens: 20,
      totalTokens: 140,
      cacheHitPct: 70,
    },
    context: { usedTokens: 0, windowTokens: 100, percent: 0, approximate: true },
    model: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' },
    preset: 'reviewer',
    title: 'Inspector fixture',
    effectiveCwd: '/host/project',
    goal: { objective: 'finish PR2', phase: 'active' },
    todos: { pending: 2, inProgress: 1, completed: 1 },
  } satisfies SessionInspectorData)
  assert.deepEqual([...INSPECTOR_PROJECTION_KEYS], [
    'sessionStats',
    'tokenUsage',
    'contextPressure',
    'modelSelection',
    'agentPreset',
    'title',
    'workingDirectory',
    'goal',
    'todos',
  ], 'the ONE fixed Inspector key list is the official projection request set')
})

test('INSPECTOR-02 an authoritative zero is kept and a missing denominator omits only its derived value', () => {
  const data = detachSessionInspector(SESSION, -1, fixture({
    sessionStats: {
      turns: 0,
      steps: 0,
      llmMs: 0,
      toolMs: 0,
      ttftMs: 0,
      ttftSteps: 0,
      decodeMs: 0,
      decodeTokens: 0,
    },
    tokenUsage: {
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    contextPressure: { projectedTokens: 0, contextWindow: 0 },
  }))
  assert.equal(data.asOfSeq, -1, 'an empty log cut is legal and stays exact')
  assert.deepEqual(data.stats, { turns: 0, steps: 0, llmMs: 0, toolMs: 0 },
    'real zeros survive; no TTFT/decode denominator means no fabricated average/TPS')
  assert.deepEqual(data.usage, {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  }, 'zero buckets stay a known zero usage; a zero denominator has no cache ratio')
  assert.deepEqual(data.context, { usedTokens: 0, approximate: true },
    'a non-positive window is not a capacity; the legal zero numerator still crosses')
})

test('INSPECTOR-03 a missing/malformed unit omits its own group without losing the other legal groups', () => {
  const missing = detachSessionInspector(SESSION, 0, {
    tokenUsage: fullUsage,
    contextPressure: { projectedTokens: 10, contextWindow: 100 },
  })
  assert.equal(missing.stats, undefined, 'a missing stats unit is unknown, never an all-zero statistic')
  assert.deepEqual(missing.usage, {
    uncachedInputTokens: 10,
    outputTokens: 40,
    cacheReadTokens: 70,
    cacheWriteTokens: 20,
    totalTokens: 140,
    cacheHitPct: 70,
  }, 'another legal group is not dropped with the missing one')
  assert.deepEqual(missing.context, { usedTokens: 10, windowTokens: 100, percent: 10, approximate: true })
  assert.equal(missing.sessionId, SESSION)

  const malformedStats = detachSessionInspector(SESSION, 0, fixture({
    sessionStats: { ...fullStats, turns: 2.5, toolMs: -1 },
  }))
  assert.equal(malformedStats.stats, undefined, 'a non-integer count or negative wall time invalidates the unit')
  assert.ok(malformedStats.usage !== undefined, 'the usage group still crosses')

  const malformedUsage = detachSessionInspector(SESSION, 0, fixture({
    tokenUsage: { ...fullUsage, outputTokens: '40' },
  }))
  assert.equal(malformedUsage.usage, undefined, 'a malformed bucket omits the whole usage group')
  assert.ok(malformedUsage.stats !== undefined, 'the stats group still crosses')

  const overflowing = detachSessionInspector(SESSION, 0, fixture({
    tokenUsage: {
      uncachedInputTokens: Number.MAX_VALUE,
      outputTokens: Number.MAX_VALUE,
      cacheReadTokens: Number.MAX_VALUE,
      cacheWriteTokens: Number.MAX_VALUE,
    },
  }))
  assert.equal(overflowing.usage, undefined, 'a non-finite total is omitted, never emitted as Infinity')
})

test('INSPECTOR-04 the context numerator never falls back from a present-but-illegal preferred field', () => {
  const badPreferred = detachSessionInspector(SESSION, 0, {
    contextPressure: { projectedTokens: -1, pressureTokens: 50, contextWindow: 100 },
  })
  assert.deepEqual(badPreferred.context, { windowTokens: 100, approximate: true },
    'a present illegal projectedTokens leaves the numerator unknown; it is not replaced by pressureTokens')

  const absentPreferred = detachSessionInspector(SESSION, 0, {
    contextPressure: { pressureTokens: 50, contextWindow: 100 },
  })
  assert.deepEqual(absentPreferred.context, { usedTokens: 50, windowTokens: 100, percent: 50, approximate: true },
    'an absent preferred field legally falls back to pressureTokens')

  const overCapacity = detachSessionInspector(SESSION, 0, {
    contextPressure: { projectedTokens: 250, contextWindow: 100 },
  })
  assert.deepEqual(overCapacity.context, { usedTokens: 250, windowTokens: 100, percent: 100, approximate: true },
    'the real numerator/window stay intact while the displayed percent is clamped')

  const noContext = detachSessionInspector(SESSION, 0, { contextPressure: { pressureTokens: 'oops' } })
  assert.equal(noContext.context, undefined, 'no legal numerator or window means no context group')
})

test('INSPECTOR-05 the existing detached status fields keep null/absent/unknown distinct', () => {
  const explicitEmpty = detachSessionInspector(SESSION, 0, fixture({
    goal: null,
    todos: null,
    title: '',
    agentPreset: '',
    workingDirectory: '',
  }))
  assert.equal(explicitEmpty.goal, null, 'the official legal null goal is a known no-goal answer')
  assert.equal(explicitEmpty.todos, null, 'the official legal null todos is a known empty list')
  assert.equal(explicitEmpty.title, undefined, 'an empty title is absent, never an empty title fact')
  assert.equal(explicitEmpty.preset, undefined)
  assert.equal(explicitEmpty.effectiveCwd, undefined, 'an empty workingDirectory never becomes an effective cwd')

  const malformed = detachSessionInspector(SESSION, 0, fixture({
    goal: { goal: { objective: 'broken', phase: 'unknown-phase' } },
    todos: [{ content: 'bad', status: 'doing' }],
    modelSelection: { next: { provider: '', model: 'm' }, lastUsed: { provider: 'deepseek', model: 'fallback' } },
  }))
  assert.equal(malformed.goal, undefined, 'a malformed goal is unknown, never null and never a guessed phase')
  assert.equal(malformed.todos, undefined, 'a malformed todo item invalidates the list')
  assert.deepEqual(malformed.model, { provider: 'deepseek', model: 'fallback' },
    'the existing next ?? lastUsed mapper still selects the legal fallback')

  const unknown = detachSessionInspector(SESSION, 0, {})
  assert.deepEqual(unknown, { sessionId: SESSION, asOfSeq: 0 },
    'an empty projection dictionary carries only identity and the exact cut')
})
