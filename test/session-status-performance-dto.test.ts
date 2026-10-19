/**
 * TPS plan PR-2: the `piTuiPerformance` boundary mapping of the shared Session
 * status DTO. The wire value arrives from an official projection frame (or a
 * Direct registry read), so it is validated as UNTRUSTED JSON: a well-formed
 * projection maps verbatim, and a malformed, partial or foreign value reads
 * ABSENT — never a partially copied or coerced projection.
 * @module @xmoon76/dsh-pi-tui/session-status-performance-dto.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { detachedSessionStatus } from '../src/runtime/session-status-projection.ts'
import { PI_TUI_PERFORMANCE_KEY } from '../src/domain/status/performance-view.ts'

const WELL_FORMED = {
  recent: { outputTokens: 200, modelMs: 2000, samples: 2, firstTokenMs: 300, firstTokenSamples: 2 },
  all: { outputTokens: 500, modelMs: 5000, samples: 5 },
}

test('a well-formed Host projection maps verbatim into the status DTO', () => {
  const status = detachedSessionStatus('s', { [PI_TUI_PERFORMANCE_KEY]: WELL_FORMED }, undefined)
  assert.deepEqual(status.performance, WELL_FORMED)
})

test('an absent Host projection stays absent (capability unavailable, never zeros)', () => {
  assert.equal(detachedSessionStatus('s', {}, undefined).performance, undefined)
  assert.equal(detachedSessionStatus('s', { [PI_TUI_PERFORMANCE_KEY]: undefined }, undefined).performance, undefined)
})

test('a malformed, partial or foreign Host projection reads ABSENT', () => {
  const malformed: unknown[] = [
    null,
    'piTuiPerformance',
    42,
    [],
    { recent: WELL_FORMED.recent },                                   // All scope missing
    { all: WELL_FORMED.all },                                         // recent scope missing
    { recent: WELL_FORMED.recent, all: { ...WELL_FORMED.all, samples: undefined } },
    { recent: { ...WELL_FORMED.recent, firstTokenSamples: Number.NaN }, all: WELL_FORMED.all },
    { recent: { ...WELL_FORMED.recent, outputTokens: Number.POSITIVE_INFINITY }, all: WELL_FORMED.all },
    { recent: { ...WELL_FORMED.recent, modelMs: -1 }, all: WELL_FORMED.all },
    { recent: { ...WELL_FORMED.recent, samples: '2' }, all: WELL_FORMED.all },
    { recent: WELL_FORMED.recent, all: 'nope' },
    { recent: null, all: WELL_FORMED.all },
  ]
  for (const value of malformed) {
    const status = detachedSessionStatus('s', { [PI_TUI_PERFORMANCE_KEY]: value }, undefined)
    assert.equal(status.performance, undefined,
      `a malformed projection must read absent: ${JSON.stringify(value)}`)
  }
})

test('a malformed Host projection never disturbs the other DTO fields', () => {
  const status = detachedSessionStatus('s', {
    [PI_TUI_PERFORMANCE_KEY]: { recent: null, all: null },
    title: 'kept',
    tokenUsage: {
      uncachedInputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    },
  }, '/ws')
  assert.equal(status.performance, undefined)
  assert.equal(status.title, 'kept')
  assert.equal(status.cwd, '/ws')
  assert.deepEqual(status.usage, {
    uncachedInputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
  })
})
