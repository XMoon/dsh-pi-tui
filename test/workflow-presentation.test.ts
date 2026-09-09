/**
 * Pure presentation projection tests for the scalable Workflow UI (PR2 plan
 * §16.1): phase identity, adaptive thresholds, the capped abnormal preview,
 * aggregate precedence and the run-level View-all rule. The combinatorics
 * live HERE — the renderer tests only assert structural output.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORKFLOW_ANOMALY_PREVIEW_LIMIT,
  WORKFLOW_INLINE_MEMBER_LIMIT,
  workflowAggregateStatus,
  workflowCountsText,
  workflowPhasePresentations,
  workflowRunSummaryText,
  workflowRunViewAllVisible,
  workflowStatusCounts,
} from '../src/workflow-presentation.ts'
import { workflowPhaseKey, workflowReadablePhase, type WorkflowMemberView, type WorkflowRunStatus } from '../src/transcript.ts'

const member = (seq: number, label: string, phase: string | null, status: WorkflowRunStatus): WorkflowMemberView =>
  ({ seq, label, phase, childId: `child-${seq}` as never, status })

test('phase identity: null, empty and named phases stay distinct with distinct readable labels', () => {
  const presentations = workflowPhasePresentations([
    member(0, 'a', null, 'completed'),
    member(1, 'b', '', 'completed'),
    member(2, 'c', 'Research', 'completed'),
  ])
  assert.equal(presentations.length, 3, 'null / empty / named must be three groups')
  const keys = new Set(presentations.map(p => p.key))
  assert.equal(keys.size, 3, 'phase keys must be collision-free')
  assert.notEqual(workflowPhaseKey(null), workflowPhaseKey(''))
  assert.notEqual(workflowReadablePhase(null), workflowReadablePhase(''))
  assert.equal(workflowReadablePhase(null), 'Unassigned')
  assert.equal(workflowReadablePhase(''), 'Empty')
  assert.equal(workflowReadablePhase('Research'), 'Research')
  const labels = presentations.map(p => p.label)
  assert.ok(labels.includes('Unassigned') && labels.includes('Empty') && labels.includes('Research'),
    `readable labels must distinguish the identities: ${labels.join(', ')}`)
})

test('phase grouping preserves durable arrival order and first-appearance order', () => {
  const presentations = workflowPhasePresentations([
    member(0, 'a', 'Research', 'completed'),
    member(1, 'b', 'Verify', 'completed'),
    member(2, 'c', 'Research', 'running'),
  ])
  assert.deepEqual(presentations.map(p => p.label), ['Research', 'Verify'])
  assert.deepEqual(presentations[0]!.members.map(m => m.seq), [0, 2], 'members keep durable seq order')
})

test('adaptive threshold: <=5 members inline, >5 summary', () => {
  // 0 members: no phase groups at all (a group exists only via its members).
  assert.deepEqual(workflowPhasePresentations([]), [])
  for (const count of [1, WORKFLOW_INLINE_MEMBER_LIMIT]) {
    const members = Array.from({ length: count }, (_, i) => member(i, `m${i}`, 'Research', 'completed'))
    const [phase] = workflowPhasePresentations(members)
    assert.equal(phase?.mode, 'inline', `${count} members must be inline`)
  }
  for (const count of [WORKFLOW_INLINE_MEMBER_LIMIT + 1, 100]) {
    const members = Array.from({ length: count }, (_, i) => member(i, `m${i}`, 'Research', 'completed'))
    const [phase] = workflowPhasePresentations(members)
    assert.equal(phase?.mode, 'summary', `${count} members must be summary`)
  }
})

test('large phase preview: exact counts, abnormal-only, capped, seq-stable, hidden count', () => {
  const members: WorkflowMemberView[] = [
    ...Array.from({ length: 10 }, (_, i) => member(i, `done-${i}`, 'Migration', 'completed')),
    ...Array.from({ length: 5 }, (_, i) => member(10 + i, `run-${i}`, 'Migration', 'running')),
    member(15, 'fail-1', 'Migration', 'failed'),
    member(16, 'cancel-1', 'Migration', 'cancelled'),
    member(17, 'interrupt-1', 'Migration', 'interrupted'),
    member(18, 'fail-2', 'Migration', 'failed'),
  ]
  const [phase] = workflowPhasePresentations(members)
  assert.ok(phase !== undefined)
  assert.equal(phase.mode, 'summary')
  assert.deepEqual(phase.counts, { running: 5, completed: 10, failed: 2, cancelled: 1, interrupted: 1 })
  // Preview: abnormal only, in seq order, capped at 3 — never a running/completed top-N.
  assert.deepEqual(phase.anomalyPreview.map(m => m.seq), [15, 16, 17])
  assert.equal(phase.anomalyPreview.length, WORKFLOW_ANOMALY_PREVIEW_LIMIT)
  assert.equal(phase.hiddenAnomalyCount, 1, 'the 4th abnormal (seq 18) stays hidden')
  assert.ok(!phase.anomalyPreview.some(m => m.status === 'running' || m.status === 'completed'),
    'preview must never inline running/completed members')
})

test('aggregate status precedence: failed > interrupted > cancelled > running > completed', () => {
  const cases: Array<[WorkflowRunStatus[], WorkflowRunStatus]> = [
    [['completed'], 'completed'],
    [['running', 'completed'], 'running'],
    [['cancelled', 'running'], 'cancelled'],
    [['interrupted', 'cancelled'], 'interrupted'],
    [['failed', 'interrupted'], 'failed'],
    [['failed', 'cancelled', 'running', 'completed'], 'failed'],
  ]
  for (const [statuses, expected] of cases) {
    const members = statuses.map((status, i) => member(i, `m${i}`, 'P', status))
    assert.equal(workflowAggregateStatus(members), expected, `${statuses.join(',')} -> ${expected}`)
  }
})

test('run summary and phase counts text: non-zero only, stable order', () => {
  assert.equal(workflowRunSummaryText({ running: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 }), '')
  assert.equal(workflowRunSummaryText({ running: 18, completed: 103, failed: 5, cancelled: 0, interrupted: 0 }),
    '126 agents · 18 running · 103 completed · 5 failed')
  assert.equal(workflowRunSummaryText({ running: 0, completed: 1, failed: 0, cancelled: 0, interrupted: 0 }), '1 agent · 1 completed')
  assert.equal(workflowCountsText({ running: 8, completed: 32, failed: 2, cancelled: 0, interrupted: 0 }),
    '8 running · 32 completed · 2 failed')
  assert.equal(workflowCountsText({ running: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 }), '')
})

test('run-level View all rule (plan §5.5)', () => {
  // total <= 5: never.
  assert.equal(workflowRunViewAllVisible(0, 1), false)
  assert.equal(workflowRunViewAllVisible(5, 2), false)
  // single phase group (large or small): the phase entry covers the run.
  assert.equal(workflowRunViewAllVisible(6, 1), false)
  assert.equal(workflowRunViewAllVisible(100, 1), false)
  // multiple phase groups with total > 5: useful.
  assert.equal(workflowRunViewAllVisible(6, 2), true)
  assert.equal(workflowRunViewAllVisible(126, 3), true)
})

test('status counts are exact for every vocabulary member', () => {
  const members = [
    member(0, 'a', null, 'running'),
    member(1, 'b', null, 'completed'),
    member(2, 'c', null, 'failed'),
    member(3, 'd', null, 'cancelled'),
    member(4, 'e', null, 'interrupted'),
  ]
  assert.deepEqual(workflowStatusCounts(members), { running: 1, completed: 1, failed: 1, cancelled: 1, interrupted: 1 })
})
