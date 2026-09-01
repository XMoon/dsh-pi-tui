/**
 * Headless tests for the status semantics derives (plan §12.11): access
 * (preset/sandbox/approval independence, custom neutrality, missing
 * services), plan (off/on/pending/fallback), activity (phase precedence),
 * and usage (structured projection).
 * @module @xmoon76/dsh-pi-tui/status-semantics.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveAccessStatus, sandboxModeName, type ApprovalServiceLike, type PermissionPresetsLike, type SandboxPolicyLike } from '../src/status/derive-access.ts'
import { deriveActivityPhase, deriveActivityStatus } from '../src/status/derive-activity.ts'
import { derivePlanStatus } from '../src/status/derive-plan.ts'
import { usageFromStats } from '../src/status/derive-usage.ts'
import type { SessionStats } from '../src/stats.ts'

// ── Access ────────────────────────────────────────────────────────────────

function presets(current: string, label?: string): PermissionPresetsLike {
  return {
    current: () => current,
    optionOf: name => ({ name, ...label === undefined ? {} : { label } }),
  }
}

function sandbox(mode: string): SandboxPolicyLike {
  return { resolve: () => ({ mode }) }
}

function approval(policy: 'ask' | 'never'): ApprovalServiceLike {
  return { overrideOf: () => policy }
}

test('access: read-only + ask derives independent facts', () => {
  const status = deriveAccessStatus(
    {
      permissionPresets: presets('read-only'),
      sandboxPolicy: sandbox('read-only'),
      approval: approval('ask'),
    },
    {},
  )
  assert.deepEqual(status, {
    permissionPreset: { id: 'read-only', label: 'read-only', matched: true },
    sandbox: { mode: 'read-only' },
    approval: { policy: 'ask' },
  })
})

test('access: danger-full-access + never', () => {
  const status = deriveAccessStatus(
    {
      permissionPresets: presets('danger-full-access', 'Danger'),
      sandboxPolicy: sandbox('danger-full-access'),
      approval: approval('never'),
    },
    {},
  )
  assert.equal(status.permissionPreset?.id, 'danger-full-access')
  assert.equal(status.permissionPreset?.label, 'Danger')
  assert.equal(status.permissionPreset?.matched, true)
  assert.equal(status.sandbox?.mode, 'danger-full-access')
  assert.equal(status.approval?.policy, 'never')
})

test('access: custom is a neutral unmatched combination, never danger', () => {
  const status = deriveAccessStatus(
    {
      permissionPresets: presets('custom'),
      sandboxPolicy: sandbox('workspace-write'),
      approval: approval('ask'),
    },
    {},
  )
  assert.equal(status.permissionPreset?.id, 'custom')
  assert.equal(status.permissionPreset?.matched, false)
  // The sandbox fact stays independent — custom does not imply danger.
  assert.equal(status.sandbox?.mode, 'workspace-write')
})

test('access: missing services degrade to absent facts', () => {
  const status = deriveAccessStatus({})
  assert.deepEqual(status, {})
})

test('access: throwing services degrade to absent facts', () => {
  const status = deriveAccessStatus(
    {
      permissionPresets: { current: () => { throw new Error('boom') }, optionOf: () => { throw new Error('boom') } },
      sandboxPolicy: { resolve: () => { throw new Error('boom') } },
      approval: { overrideOf: () => { throw new Error('boom') } },
    },
    {},
  )
  assert.deepEqual(status, {})
})

test('access: unknown sandbox modes are omitted, never guessed', () => {
  assert.equal(sandboxModeName('read-only'), 'read-only')
  assert.equal(sandboxModeName('workspace-write'), 'workspace-write')
  assert.equal(sandboxModeName('danger-full-access'), 'danger-full-access')
  assert.equal(sandboxModeName('full'), undefined)
  assert.equal(sandboxModeName(undefined), undefined)
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
  firstTokenMsAvg: 2000,
  tokensPerSec: 40,
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
  assert.deepEqual(usage.performance, { llmMs: 120000, firstTokenMs: 2000, tokensPerSec: 40 })
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

test('activity: nonzero child counts ride the section', () => {
  const status = deriveActivityStatus(
    { working: false, compacting: false, applyingCompaction: false, approvalOpen: false, questionOpen: false },
    false,
    { queuedCount: 0, taskCount: 0, childAgentCount: 4, todoCount: 0 },
  )
  assert.equal(status.childAgentCount, 4)
  assert.equal(status.taskCount, 0)
})

test('access: alpha.4 drops the event-log fold inputs entirely (service-only reads)', () => {
  // The alpha.4 sandbox-policy package removed effectiveSandboxMode and the
  // approval package removed effectiveApprovalPolicy — every access fact is
  // now a session-oriented service read, so the derive takes NO event array
  // at all and an absent service stays an absent fact.
  const without = deriveAccessStatus({})
  assert.deepEqual(without, {})
})
