/**
 * Headless tests for the status semantics derives (plan §12.11): access
 * (preset/sandbox/approval independence, custom neutrality, missing
 * services), plan (off/on/pending/fallback), activity (phase precedence),
 * and usage (structured projection).
 * @module @xmoon76/dsh-pi-tui/status-semantics.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveAccessStatus, type PermissionPresetsLike } from '../../src/domain/status/derive-access.ts'
import { deriveActivityPhase, deriveActivityStatus } from '../../src/domain/status/derive-activity.ts'
import { derivePlanStatus } from '../../src/domain/status/derive-plan.ts'
import { usageFromStats } from '../../src/domain/status/derive-usage.ts'
import type { SessionStats } from '../../src/domain/status/stats.ts'

// ── Access ────────────────────────────────────────────────────────────────

function presets(current: string, label?: string): PermissionPresetsLike {
  return {
    current: () => current,
    optionOf: name => ({ name, ...label === undefined ? {} : { label } }),
  }
}

test('access: the preset fold no longer derives the sandbox/approval knobs (M6-1 F8)', () => {
  const status = deriveAccessStatus({ permissionPresets: presets('read-only') }, {})
  assert.deepEqual(status, {
    permissionPreset: { id: 'read-only', label: 'read-only', matched: true },
  }, 'the independent knobs arrive from the policy observation, never this fold')
})

test('access: the preset label/matched fold stays exact', () => {
  const status = deriveAccessStatus({ permissionPresets: presets('danger-full-access', 'Danger') }, {})
  assert.equal(status.permissionPreset?.id, 'danger-full-access')
  assert.equal(status.permissionPreset?.label, 'Danger')
  assert.equal(status.permissionPreset?.matched, true)
})

test('access: custom is a neutral unmatched combination, never danger', () => {
  const status = deriveAccessStatus({ permissionPresets: presets('custom') }, {})
  assert.equal(status.permissionPreset?.id, 'custom')
  assert.equal(status.permissionPreset?.matched, false)
  // The sandbox/approval facts are independent observation facts — the
  // derive never infers them from a preset name (custom does not imply danger).
  assert.equal('sandbox' in status, false)
  assert.equal('approval' in status, false)
})

test('access: missing services degrade to absent facts', () => {
  const status = deriveAccessStatus({})
  assert.deepEqual(status, {})
})

test('access: a throwing preset service degrades to an absent fact', () => {
  const status = deriveAccessStatus(
    {
      permissionPresets: { current: () => { throw new Error('boom') }, optionOf: () => { throw new Error('boom') } },
    },
    {},
  )
  assert.deepEqual(status, {})
})

test('access: unknown modes never reach the snapshot (the observation owns the vocabulary)', () => {
  // The wire contract's closed `SandboxMode` union (the strict codec refuses
  // an unknown mode before it can reach a snapshot) owns this rule now; the
  // domain derive keeps no second mode-normalization path.
  const status = deriveAccessStatus({})
  assert.equal('sandbox' in status, false)
})

// ── Plan ──────────────────────────────────────────────────────────────────

test('plan: off / on / pending on / pending off via the official service', () => {
  assert.deepEqual(derivePlanStatus({ get: () => ({ active: false }) }, {}, undefined, undefined), { effective: false })
  assert.deepEqual(derivePlanStatus({ get: () => ({ active: true }) }, {}, undefined, undefined), { effective: true })
  assert.deepEqual(derivePlanStatus({ get: () => ({ active: false, pending: true }) }, {}, undefined, undefined),
    { effective: false, pending: true })
  assert.deepEqual(derivePlanStatus({ get: () => ({ active: true, pending: false }) }, {}, undefined, undefined),
    { effective: true, pending: false })
})

test('plan: projection fallback when the service is absent (pending from the wire view)', () => {
  const projections = {
    stateOf: () => ({ active: true, wanted: null, running: null }),
  }
  assert.deepEqual(derivePlanStatus(undefined, {}, projections, {}), { effective: true })
  const pending = {
    stateOf: () => ({ active: false, wanted: true, running: null }),
  }
  assert.deepEqual(derivePlanStatus(undefined, {}, pending, {}), { effective: false, pending: true })
  const running = {
    stateOf: () => ({ active: false, wanted: null, running: { wanted: true } }),
  }
  assert.deepEqual(derivePlanStatus(undefined, {}, running, {}), { effective: false, pending: true })
})

test('plan: absent service and projection degrade to the neutral fact', () => {
  assert.deepEqual(derivePlanStatus(undefined, {}, undefined, undefined), { effective: false })
  assert.deepEqual(derivePlanStatus(undefined, {}, { stateOf: () => undefined }, {}), { effective: false })
})

test('plan: throwing service falls back to the projection', () => {
  const projections = {
    stateOf: () => ({ active: false, wanted: null, running: null }),
  }
  assert.deepEqual(
    derivePlanStatus({ get: () => { throw new Error('boom') } }, {}, projections, {}),
    { effective: false },
  )
})

// ── Activity ──────────────────────────────────────────────────────────────

test('activity: phase precedence (approval > question > applying > compacting > working > idle)', () => {
  assert.equal(deriveActivityPhase({ working: false, compacting: false, applyingCompaction: false, approvalOpen: false, questionOpen: false }), 'idle')
  assert.equal(deriveActivityPhase({ working: true, compacting: false, applyingCompaction: false, approvalOpen: false, questionOpen: false }), 'working')
  assert.equal(deriveActivityPhase({ working: true, compacting: true, applyingCompaction: false, approvalOpen: false, questionOpen: false }), 'compacting')
  assert.equal(deriveActivityPhase({ working: true, compacting: true, applyingCompaction: true, approvalOpen: false, questionOpen: false }), 'applying-compaction')
  assert.equal(deriveActivityPhase({ working: true, compacting: true, applyingCompaction: true, approvalOpen: false, questionOpen: true }), 'waiting-question')
  assert.equal(deriveActivityPhase({ working: true, compacting: true, applyingCompaction: true, approvalOpen: true, questionOpen: true }), 'waiting-approval')
})

test('activity: busy is a separate machine fact from the phase', () => {
  const status = deriveActivityStatus(
    { working: false, compacting: false, applyingCompaction: false, approvalOpen: false, questionOpen: false },
    true,
    { queuedCount: 2, taskCount: 1, childAgentCount: 0, todoCount: 3 },
  )
  assert.equal(status.phase, 'idle')
  assert.equal(status.busy, true)
  assert.equal(status.queuedCount, 2)
  assert.equal(status.taskCount, 1)
  assert.equal(status.todoCount, 3)
})

// ── Usage ──────────────────────────────────────────────────────────────────

const STATS: SessionStats = {
  turns: 12,
  steps: 38,
  llmMs: 120000,
  cacheHitPct: 91.9,
  inputTokens: 2579,
  outputTokens: 5507,
  contextWindow: 1_000_000,
  cacheReadTokens: 20000,
  cacheWriteTokens: 0,
}

test('usage: structured projection matches the stats source', () => {
  const usage = usageFromStats(STATS)
  assert.deepEqual(usage.context, { usedTokens: 22579, windowTokens: 1_000_000, percent: 2 })
  assert.deepEqual(usage.tokens, { input: 2579, output: 5507, cacheRead: 20000, cacheWrite: 0 })
  assert.equal(usage.cacheHitPct, 91.9)
  // PR-2: the measured performance values are the Host projection's; this
  // projection contributes only the lifetime llmMs.
  assert.deepEqual(usage.performance, { llmMs: 120000 })
  assert.equal(usage.turns, 12)
  assert.equal(usage.steps, 38)
})

test('usage: no context window and no cache facts stay absent', () => {
  const usage = usageFromStats({ ...STATS, contextWindow: undefined, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.equal(usage.context, undefined)
  assert.equal(usage.cacheHitPct, undefined)
})

test('usage: the context override wins over the measured window', () => {
  // The runner passes the tokenMeter's measurement as the override: the
  // derived context uses THAT (the stats window is the fallback).
  const usage = usageFromStats(STATS, 50_000)
  assert.deepEqual(usage.context, { usedTokens: 50000, windowTokens: 1_000_000, percent: 5 })
})

test('usage: zero/negative windows clamp and never divide by zero', () => {
  const zero = usageFromStats({ ...STATS, contextWindow: 0 })
  assert.equal(zero.context, undefined, 'a zero window must not fabricate a context bar')
  const negative = usageFromStats({ ...STATS, contextWindow: -100 })
  assert.equal(negative.context, undefined, 'a negative window must not fabricate a context bar')
  // The override path clamps too: an over-100% measurement caps at 100.
  const over = usageFromStats({ ...STATS, contextWindow: 10 }, 50_000)
  assert.deepEqual(over.context, { usedTokens: 50000, windowTokens: 10, percent: 100 })
})

test('usage: cache-write-only data carries its own hit percentage', () => {
  const usage = usageFromStats({ ...STATS, cacheReadTokens: 0, cacheWriteTokens: 500 })
  assert.deepEqual(usage.tokens, { input: 2579, output: 5507, cacheRead: 0, cacheWrite: 500 })
  assert.equal(usage.cacheHitPct, 91.9, 'the cache hit percent is the stats fact, independent of the read/write split')
})

test('activity: background task and child counts never become a lifecycle phase', () => {
  const status = deriveActivityStatus(
    { working: false, compacting: false, applyingCompaction: false, approvalOpen: false, questionOpen: false },
    false,
    { queuedCount: 0, taskCount: 1, childAgentCount: 4, todoCount: 0 },
  )
  assert.equal(status.phase, 'idle')
  assert.equal(status.childAgentCount, 4)
  assert.equal(status.taskCount, 1)
})

test('access: alpha.4 drops the event-log fold inputs entirely (service-only reads)', () => {
  // The alpha.4 sandbox-policy package removed effectiveSandboxMode and the
  // approval package removed effectiveApprovalPolicy — every access fact is
  // now a session-oriented service read, so the derive takes NO event array
  // at all and an absent service stays an absent fact.
  const without = deriveAccessStatus({})
  assert.deepEqual(without, {})
})

// ── PR-2: the measured performance values are the Host projection's ────────

test('usage PR-2: usageFromStats contributes ONLY the lifetime llmMs, never a fold-derived rate', () => {
  // The measured performance facts are the bundle's Host `piTuiPerformance`
  // projection's; StatusRuntime injects the derived figures. The fold must
  // not be a second source — not even as a zero.
  assert.deepEqual(usageFromStats(STATS).performance, { llmMs: 120000 })
  const official = { tokens: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  assert.deepEqual(usageFromStats(STATS, undefined, official).performance, { llmMs: 120000 },
    'the Remote projection-override branch keeps the same rule')
})
